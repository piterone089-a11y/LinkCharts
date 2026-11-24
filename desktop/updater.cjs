// In-app updates from the app's GitHub Releases (the same file is in Cutline and LinkCharts).
// The page asks "is there a newer version?"; on Windows the new installer is then downloaded in the
// background and run silently once the app has closed, and the new version opens by itself. A Mac app that
// isn't signed by Apple can't replace itself, so there the new download just opens in the browser.
const { app, ipcMain, shell, net } = require("electron");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** The installer may only be fetched from GitHub's own hosts. */
const TRUSTED_DOWNLOAD_HOSTS = /(^|\.)(github\.com|githubusercontent\.com)$/i;

/** SHA-256 of a file, streamed so a 100 MB installer isn't read into memory. */
function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => hash.update(c)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
}

/** True when version a ("1.23.0") is newer than b. */
function newer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0), pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/**
 * repo: "Owner/Name" on GitHub. assets: { win32: /Setup-.*\.exe$/, darwin: /\.dmg$/ } — which release file
 * is this computer's installer. isTrustedUrl(url) says whether a request comes from the app's own page.
 */
function setupUpdates({ repo, assets, isTrustedUrl }) {
  let latest = null; // { version, notes, page, asset: { name, url, size, digest } | null }
  let file = null; // the downloaded installer
  let downloading = null;

  /** Only the app's own page may ask for an (unsigned) installer to be downloaded and run. */
  function assertTrusted(event) {
    if (typeof isTrustedUrl !== "function") return;
    const from = event?.senderFrame?.url || "";
    if (!isTrustedUrl(from)) throw new Error("Blocked: this request did not come from the LinkCharts window.");
  }

  async function check() {
    const r = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `${app.getName()}/${app.getVersion()}` },
    });
    if (!r.ok) throw new Error(r.status === 403 ? "GitHub is busy right now — try again in a few minutes." : `GitHub answered ${r.status}.`);
    const rel = await r.json();
    const a = (rel.assets || []).find((x) => assets[process.platform]?.test(x.name));
    latest = {
      version: String(rel.tag_name || "").replace(/^v/i, ""),
      notes: rel.body || "",
      page: rel.html_url,
      // digest is GitHub's own SHA-256 for the uploaded file ("sha256:…"); we refuse to run a file without one.
      asset: a ? { name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest || null } : null,
    };
    return {
      current: app.getVersion(),
      version: latest.version,
      notes: latest.notes,
      page: latest.page,
      available: newer(latest.version, app.getVersion()),
      // Running from source (npm start) there's no installed app to replace.
      canInstall: process.platform === "win32" && !!latest.asset && app.isPackaged,
    };
  }

  async function download(sender) {
    if (!latest?.asset) await check();
    const a = latest.asset;
    if (!a) throw new Error("This release has no installer for this computer.");
    if (!a.digest) throw new Error("This release doesn't publish a checksum, so LinkCharts won't install it automatically. Download it from the release page.");
    const expected = String(a.digest).replace(/^sha256:/i, "").toLowerCase();
    // The user's own app-data folder, not the shared temp folder anyone on this machine can write to.
    const dest = path.join(app.getPath("userData"), "updates", path.basename(a.name));
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    if (fs.existsSync(dest)) {
      const same = fs.statSync(dest).size === a.size && (await sha256(dest)) === expected;
      if (same) return (file = dest); // downloaded and verified before
      fs.rmSync(dest, { force: true }); // partial or tampered: fetch it again
    }
    const host = (() => { try { return new URL(a.url); } catch { return null; } })();
    if (!host || host.protocol !== "https:" || !TRUSTED_DOWNLOAD_HOSTS.test(host.hostname)) throw new Error("The download link is not from GitHub — not downloading it.");
    const r = await net.fetch(a.url);
    if (!r.ok || !r.body) throw new Error(`The download failed (${r.status}).`);
    const part = dest + ".part";
    const out = fs.createWriteStream(part, { mode: 0o600 });
    let got = 0, told = 0;
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(value)) await new Promise((res) => out.once("drain", res));
        if (Date.now() - told > 150) { told = Date.now(); if (!sender.isDestroyed()) sender.send("updates:progress", a.size ? got / a.size : 0); }
      }
    } finally {
      await new Promise((res) => out.end(res));
    }
    if (a.size && got !== a.size) throw new Error("The download was interrupted — try again.");
    // Never run a file that isn't exactly the one GitHub published.
    if ((await sha256(part)) !== expected) {
      fs.rmSync(part, { force: true });
      throw new Error("The downloaded installer doesn't match GitHub's checksum — not installing it.");
    }
    fs.renameSync(part, dest);
    return (file = dest);
  }

  /** Only ever hand an https GitHub link to the browser, never a scheme an attacker could pick. */
  const openGithub = (u) => shell.openExternal(typeof u === "string" && /^https:\/\/(www\.)?github\.com\//i.test(u) ? u : `https://github.com/${repo}/releases/latest`);

  ipcMain.handle("updates:check", (e) => { assertTrusted(e); return check(); });
  ipcMain.handle("updates:download", (e) => { assertTrusted(e); return (downloading ||= download(e.sender).finally(() => { downloading = null; })).then(() => true); });
  ipcMain.handle("updates:install", (e) => {
    assertTrusted(e);
    if (process.platform !== "win32" || !app.isPackaged) {
      openGithub(latest?.asset?.url || latest?.page);
      return false;
    }
    if (!file) throw new Error("Download the update first.");
    // Close normally (the app saves your work on the way out); once it has quit, the installer runs
    // silently into the same folder (--updated keeps shortcuts and settings) and opens the new version
    // (--force-run) — the way electron-updater does it.
    const installer = file;
    app.once("quit", () => {
      spawn(installer, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore" }).unref();
    });
    setTimeout(() => app.quit(), 100);
    return true;
  });
  ipcMain.handle("updates:open-page", (e) => {
    assertTrusted(e);
    return openGithub(latest?.page);
  });
}

module.exports = { setupUpdates, newer };
