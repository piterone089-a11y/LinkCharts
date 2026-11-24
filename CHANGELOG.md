# Changelog

Every version is a git tag (`v1.3.2`) and its release notes are the tagged commit's message —
that text is what the app's "What's new" and the GitHub release show. Add a section here when you
release, then run `npm run release -- <version>` (see [RELEASING.md](RELEASING.md)).

## [1.3.2] - 2026-11-24

### Added
- **OKX** as a data source (⚙ › Data sources & API keys): spot pairs, perpetual swaps (`BTC-USDT-SWAP`) and dated futures (`BTC-USD-261127`). API key, secret and passphrase are optional — with all three saved, requests are signed and count against your own rate limit.
- **Korea** market in the screener: every KOSPI and KOSDAQ stock from Naver Finance, with 52-week range, moving averages and 1W–1Y returns from Yahoo. Prices in ₩.
- The screener's OKX market lists perpetual swaps and dated futures alongside spot, with a filter for each. Derivative rows open their own OKX chart and work in watchlists.

### Changed
- The screener offers United States, Korea and Crypto (OKX); the markets that depended on Yahoo's blocked screener are gone.
- Korean and Japanese amounts use plain thousands (`182,900`, not `1,82,900`), and won prices show no decimals.

### Fixed
- The screener's 1W–1Y columns could stay blank for every stock (broken import after 1.3.1).

## [1.3.1] - 2026-11-24

### Security
- API keys can no longer be read through an encoded URL such as `/%64ata/config.json`.
- One malformed address could stop the server; it now answers 400 and keeps running.
- Requests from other websites are refused (Host and Origin checks, JSON-only bodies); `data/*.json` is saved owner-only (0600).
- "Log in with Zerodha" is only accepted when the login was started from LinkCharts itself.
- The chart library loads with a pinned integrity hash, and the page runs under a Content-Security-Policy.
- Updates are verified against GitHub's SHA-256 for the installer; an installer without one is never run.

### Changed
- Electron 44.9.0 → 44.11.5.

## [1.3.0] - 2026-11-06

### Added
- New default theme "Studio": light, airy cards, rounded pill buttons, a floating drawing toolbar, round watchlist icons, the Outfit font and gentle hover/pop-in animations.
- Zerodha Kite: save the API key and secret, then "Log in with Zerodha" once a day — no more pasting an access token.

## [1.2.0] - 2026-10-26

### Added
- LinkCharts updates itself: a bar announces a new version with what's new, "Update now" downloads in the background, "Restart & update" installs it silently and reopens the app. Your data stays.
- ⚙ › App updates: your version, "Check for updates", and an automatic check on/off.

## [1.1.0] - 2026-10-19

### Added
- Desktop app (Electron): the server starts inside the app, so no Node.js, browser or console window is needed.
- Data lives in `%APPDATA%\LinkCharts\data`, so it survives updates.
- GitHub Actions builds `LinkCharts-Setup-<version>.exe` and attaches it to each release.
