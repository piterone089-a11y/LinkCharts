// Stock screener: United States (Nasdaq's public screener + Yahoo daily history) and
// crypto (OKX spot tickers). Per-market sources live in screener-sources.mjs; rows are
// filtered and sorted precisely on the client.
import { yahoo, getJson } from "./providers.mjs";
import { screenUS, US_EXCHANGES, stockMetrics, mapLimit } from "./screener-sources.mjs";

export const SCREENER_MARKETS = {
  us: { label: "United States", exchanges: US_EXCHANGES, currency: "USD", source: "Nasdaq screener + Yahoo history" },
  korea: { label: "Korea", exchanges: { KOSPI: "KOSPI", KOSDAQ: "KOSDAQ" }, currency: "KRW", source: "Naver Finance + Yahoo history" },
  crypto: {
    label: "Crypto (OKX)",
    exchanges: { USD: "USDT pairs (spot, ≈ USD)", EUR: "EUR pairs (spot)", BTC: "BTC pairs (spot)", ETH: "ETH pairs (spot)", SWAP: "Perpetual swaps", FUT: "Dated futures" },
    currency: "USD", source: "OKX spot, perpetuals & futures (24h)",
  },
};
export const SECTORS = ["Basic Materials", "Communication Services", "Consumer Cyclical", "Consumer Defensive", "Energy", "Financial Services", "Healthcare", "Industrials", "Real Estate", "Technology", "Utilities"];

const screenCache = new Map();

/** Runs a screen and returns up to `limit` rows (largest companies first) plus the total match count. */
export async function runScreen(req) {
  const limit = Math.min(Math.max(+req.limit || 500, 50), 1500);
  const key = JSON.stringify({ ...req, limit });
  const hit = screenCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let value;
  if (req.market === "us") value = await screenUS({ exchanges: req.exchanges, filters: req.filters, limit });
  else if (req.market === "korea") value = await screenKorea({ exchanges: req.exchanges, filters: req.filters, limit });
  else if (req.market === "crypto") value = await screenCrypto({ exchanges: req.exchanges, filters: req.filters, limit });
  else throw Object.assign(new Error("Unknown market"), { status: 400 });
  screenCache.set(key, { at: Date.now(), value });
  if (screenCache.size > 50) screenCache.delete(screenCache.keys().next().value);
  return value;
}

// ---------------- Korea: Naver Finance (KOSPI / KOSDAQ) ----------------

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36";
const KR_MARKET = { KOSPI: "KS", KOSDAQ: "KQ" }; // Naver market → Yahoo exchange suffix
const KR_MCAP = 1e8; // Naver's marketValue is in 억원 (100 million won)
const KR_VALUE = 1e6; // Naver's accumulatedTradingValue is in 백만원 (million won)
const numStr = (v) => { const n = parseFloat(String(v ?? "").replace(/[,\s]/g, "")); return Number.isFinite(n) ? n : null; };

const koreaCache = new Map();
/** One page (100 stocks) of a KOSPI/KOSDAQ list, already sorted by market cap by Naver. */
async function koreaPage(market, page) {
  const key = `${market}:${page}`;
  const hit = koreaCache.get(key);
  if (hit && Date.now() - hit.at < 3 * 60_000) return hit;
  const body = await getJson(`https://m.stock.naver.com/api/stocks/marketValue/${market}?page=${page}&pageSize=100`, { headers: { "User-Agent": UA } });
  const rows = (body.stocks || []).map((s) => {
    const code = s.stockExchangeType?.code === "KQ" || s.sosok === "1" ? "KQ" : "KS";
    const price = numStr(s.closePrice);
    if (!s.itemCode || !(price > 0) || ["etf", "etn"].includes(s.stockEndType)) return null; // stocks, not listed funds
    return {
      symbol: `${s.itemCode}.${code}`, name: s.stockName, exchange: KR_MARKET.KOSPI === code ? "KOSPI" : "KOSDAQ", currency: "KRW",
      price, change: numStr(s.compareToPreviousClosePrice), changePct: numStr(s.fluctuationsRatio),
      volume: numStr(s.accumulatedTradingVolume), turnover: (numStr(s.accumulatedTradingValue) || 0) * KR_VALUE,
      mcap: (numStr(s.marketValue) || 0) * KR_MCAP, pe: null, divYield: null, relVol: null,
    };
  }).filter(Boolean);
  const value = { at: Date.now(), rows, total: body.totalCount ?? rows.length };
  koreaCache.set(key, value);
  if (koreaCache.size > 40) koreaCache.delete(koreaCache.keys().next().value); // bounded: two markets × pages
  return value;
}

/** KOSPI + KOSDAQ stocks from Naver, by market cap, enriched with a year of Yahoo daily prices. */
export async function screenKorea({ exchanges = [], filters = {}, limit = 500 }) {
  const picks = (exchanges.length ? exchanges : Object.keys(KR_MARKET)).filter((k) => KR_MARKET[k]);
  const wanted = Math.min(Math.max(limit, 50), 1000);
  const pages = Math.max(1, Math.ceil(wanted / 100));
  const first = await Promise.all(picks.map((m) => koreaPage(m, 1)));
  const rest = await Promise.all(picks.flatMap((m) => Array.from({ length: pages - 1 }, (_, i) => koreaPage(m, i + 2))));
  const all = [...first.flatMap((p) => p.rows), ...rest.flatMap((p) => p.rows)];
  const total = first.reduce((a, p) => a + p.total, 0);

  const f = filters || {};
  const inRange = (v, lo, hi) => v != null && (lo == null || v >= +lo) && (hi == null || v <= +hi);
  const matched = all.filter((r) => (f.priceMin == null && f.priceMax == null || inRange(r.price, f.priceMin, f.priceMax))
    && (f.chgMin == null && f.chgMax == null || inRange(r.changePct, f.chgMin, f.chgMax))
    && (f.volMin == null && f.volMax == null || inRange(r.volume, f.volMin, f.volMax))
    && (f.mcapMin == null && f.mcapMax == null || inRange(r.mcap, f.mcapMin, f.mcapMax)));
  matched.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  const top = matched.slice(0, wanted);
  // Naver gives today's price/volume/market cap; Yahoo fills 52-week range, moving averages and returns.
  const metrics = await mapLimit(top, 16, (r) => stockMetrics(r.symbol));
  const rows = top.map((r, i) => (metrics[i] ? { ...metrics[i], ...r } : r));
  return {
    total, matched: matched.length, returned: rows.length, currency: "KRW", rows, sectors: [],
    universe: `${picks.join(" + ")} · top ${rows.length.toLocaleString()} of ${total.toLocaleString()} by market cap`,
    at: Math.floor(Date.now() / 1000),
  };
}

// ---------------- Crypto: OKX spot ----------------

/** Screener "exchange" code → OKX quote currency. USDT pairs are shown as USD (≈1:1), like the rest of the app. */
const OKX_QUOTE = { USD: "USDT", EUR: "EUR", BTC: "BTC", ETH: "ETH" }; // spot quotes offered as filters
const OKX_TYPES = { SWAP: "perp", FUT: "dated" }; // derivative filters (perpetual swaps, dated futures)
const OKX_STABLES = new Set(["USDT", "USDC", "DAI", "TUSD", "USDD", "FDUSD", "PYUSD", "USDE", "USDG", "USDS", "BUSD", "EURT"]);

/** "261127" → "27 Nov 26" (OKX expiry suffix of a dated future). */
function expiryLabel(yymmdd) {
  const yy = +yymmdd.slice(0, 2), mm = +yymmdd.slice(2, 4), dd = +yymmdd.slice(4, 6);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${dd} ${months[mm - 1] ?? mm} ${yy}`;
}

const okxApi = async (path, what) => {
  const body = await getJson(`https://www.okx.com/api/v5/${path}`);
  if (String(body?.code ?? "0") !== "0") throw Object.assign(new Error(body?.msg || `OKX ${what} unavailable`), { status: 502 });
  return body.data || [];
};

let okxTickers = null; // { at, rows } — spot + perpetual swaps + dated futures
async function okxPairs() {
  if (okxTickers && Date.now() - okxTickers.at < 30_000) return okxTickers.rows;
  const [spot, swap, fut, futList] = await Promise.all([
    okxApi("market/tickers?instType=SPOT", "spot tickers"),
    okxApi("market/tickers?instType=SWAP", "swap tickers"),
    okxApi("market/tickers?instType=FUTURES", "futures tickers"),
    okxApi("public/instruments?instType=FUTURES", "futures list"),
  ]);
  const liveFuture = new Set(futList.filter((i) => i.state === "live" && /^[A-Z0-9]+-[A-Z]{2,5}-\d{6}$/.test(i.instId)).map((i) => i.instId));
  const price = (t) => ({ last: +t.last, open: +t.open24h });

  /** One screener row. Derivatives report their 24h volume in the base coin, so multiply by price for a comparable value. */
  const row = (t, { base, quote, type, code, symbol, name, exchange, value24h }) => {
    const { last, open } = price(t);
    if (!(last > 0) || !(open > 0)) return null;
    return {
      base, quote, type, code, symbol, name, exchange, currency: "USD",
      price: last, change: last - open, changePct: (last / open - 1) * 100,
      open, high: +t.high24h || null, low: +t.low24h || null, prevClose: open,
      volume: value24h, turnover: value24h, // 24h value traded, in USD
      mcap: null, pe: null, divYield: null, relVol: null,
    };
  };

  const rows = [
    ...spot.map((t) => {
      const [base, quote] = String(t.instId || "").split("-");
      if (!base || !quote || OKX_STABLES.has(base) || base === quote) return null;
      const code = quote === "USDT" ? "USD" : quote; // USDT pairs are shown as USD (≈1:1), like the rest of the app
      return row(t, { base, quote, type: "spot", code, symbol: `${base}-${code}`, name: `${base} / ${quote}`, exchange: "OKX", value24h: +t.volCcy24h });
    }),
    ...swap.map((t) => {
      const [base, quote, kind] = String(t.instId || "").split("-");
      if (kind !== "SWAP" || !base || !quote || OKX_STABLES.has(base)) return null;
      return row(t, { base, quote, type: "perp", code: "SWAP", symbol: t.instId, name: `${base} / ${quote} perp`, exchange: "OKX Perp", value24h: (+t.volCcy24h || 0) * +t.last });
    }),
    ...fut.filter((t) => liveFuture.has(t.instId)).map((t) => {
      const [base, quote, exp] = String(t.instId || "").split("-");
      if (!base || !quote || !exp || OKX_STABLES.has(base)) return null;
      return row(t, { base, quote, type: "dated", code: "FUT", symbol: t.instId, name: `${base} / ${quote} · ${expiryLabel(exp)}`, exchange: "OKX Fut", value24h: (+t.volCcy24h || 0) * +t.last });
    }),
  ].filter(Boolean);

  okxTickers = { at: Date.now(), rows };
  return rows;
}

/** OKX spot pairs, perpetual swaps and dated futures, filtered and sorted by 24h value traded. */
export async function screenCrypto({ exchanges = [], filters = {}, limit = 500 }) {
  const codes = new Set(exchanges.length ? exchanges : [...Object.keys(OKX_QUOTE), ...Object.keys(OKX_TYPES)]);
  const f = filters || {};
  const inRange = (v, lo, hi) => v != null && (lo == null || v >= +lo) && (hi == null || v <= +hi);
  let rows = (await okxPairs()).filter((r) => codes.has(r.code)
    && (f.priceMin == null && f.priceMax == null || inRange(r.price, f.priceMin, f.priceMax))
    && (f.chgMin == null && f.chgMax == null || inRange(r.changePct, f.chgMin, f.chgMax))
    && (f.volMin == null && f.volMax == null || inRange(r.volume, f.volMin, f.volMax)));
  const matched = rows.length;
  rows.sort((a, b) => (b.turnover || 0) - (a.turnover || 0));
  const top = rows.slice(0, limit);
  const perps = top.filter((r) => r.type !== "spot").length;
  return {
    total: matched, matched, returned: top.length, currency: "USD", rows: top, sectors: [],
    universe: `OKX spot + perpetuals + futures · top ${top.length.toLocaleString()} of ${matched.toLocaleString()} by 24h value${perps ? ` (${perps} derivatives)` : ""}`,
    at: Math.floor(Date.now() / 1000),
  };
}

// ---------------- performance (1W/1M/3M/6M/YTD/1Y) from daily candles ----------------

const perfCache = new Map();
async function perfOne(symbol) {
  const hit = perfCache.get(symbol);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const { candles } = await yahoo.raw(symbol, "1d", "1y");
  const last = candles[candles.length - 1];
  const value = { symbol };
  if (last) {
    const at = (secsAgo) => { const t = last.time - secsAgo; for (let i = candles.length - 1; i >= 0; i--) if (candles[i].time <= t) return candles[i].close; return candles[0].close; };
    const pct = (base) => (base ? ((last.close - base) / base) * 100 : null);
    const yStart = Date.UTC(new Date(last.time * 1000).getUTCFullYear(), 0, 1) / 1000;
    const beforeYear = candles.filter((c) => c.time < yStart).pop(); // last close of the previous year
    Object.assign(value, {
      w1: pct(at(7 * 86400)), m1: pct(at(30 * 86400)), m3: pct(at(91 * 86400)), m6: pct(at(182 * 86400)),
      ytd: pct(beforeYear?.close ?? candles[0].close), y1: pct(candles[0].close),
    });
  }
  perfCache.set(symbol, { at: Date.now(), value });
  return value;
}

export async function performance(symbols) {
  const out = [];
  const list = symbols.slice(0, 100);
  for (let i = 0; i < list.length; i += 8) {
    const batch = await Promise.allSettled(list.slice(i, i + 8).map(perfOne));
    batch.forEach((r, j) => out.push(r.status === "fulfilled" ? r.value : { symbol: list[i + j], error: true }));
  }
  return out;
}
