// solver-server.js
// Hybrid solver: fast HTTP -> optional external APIs -> Playwright fallback
// No API key required (OPEN endpoint). Use at your own risk.

import express from "express";
import bodyParser from "body-parser";
import LRU from "lru-cache";
import { chromium } from "playwright"; // ensure playwright present on host or use playwright-core + install chromium
import { setTimeout as wait } from "timers/promises";

const PORT = process.env.PORT || 3000;
const PLAYWRIGHT_CONCURRENCY = parseInt(process.env.PW_CONCURRENCY || "2", 10);
const PLAYWRIGHT_WAIT_MS = parseInt(process.env.PW_WAIT_MS || "1500", 10);
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT || "20000", 10);
const ENABLE_EXTERNAL_APIS = (process.env.ENABLE_EXTERNAL_APIS || "false") === "true";
const ABYSM_API = process.env.ABYSM_API || "https://abysm.lat/api/free/bypass";
const TRW_API = process.env.TRW_API || "https://trw.lat/api/free/bypass";

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// simple in-memory LRU cache
const cache = new LRU({ max: 5000, ttl: 1000 * 60 * 60 }); // 1 hour

// simple semaphore for Playwright concurrency
class Semaphore {
  constructor(max) { this.max = max; this.current = 0; this.queue = []; }
  async acquire() {
    if (this.current < this.max) { this.current++; return; }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }
  release() {
    this.current = Math.max(0, this.current - 1);
    if (this.queue.length) this.queue.shift()();
  }
}
const pwSem = new Semaphore(PLAYWRIGHT_CONCURRENCY);
let playwrightBrowser = null;

// helper: timeout fetch (Node 18+ fetch)
async function fetchWithTimeout(url, opts = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, ...opts });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function hostnameOf(link) {
  try {
    const u = new URL(link);
    return u.hostname.toLowerCase();
  } catch {
    try { return new URL("https://" + link).hostname.toLowerCase(); } catch { return null; }
  }
}

// quick domain extractors
async function domainExtractor(link) {
  const host = hostnameOf(link);
  if (!host) return null;
  if (host === "pastebin.com") {
    const m = link.match(/pastebin\.com\/([A-Za-z0-9]+)/i);
    if (m) return { bypassed: `https://pastebin.com/raw/${m[1]}`, method: "pastebin-raw" };
  }
  if (host === "rentry.co") {
    const m = link.match(/rentry\.co\/([A-Za-z0-9\-]+)/i);
    if (m) return { bypassed: `https://rentry.co/${m[1]}/raw`, method: "rentry-raw" };
  }
  if (host.includes("deltaios-executor.com")) {
    const m = link.match(/[?&]URL=([^&]+)/i);
    if (m) return { bypassed: decodeURIComponent(m[1]), method: "param-URL" };
  }
  return null;
}

// follow redirects to unshorten
async function tryFollowRedirect(link) {
  try {
    const res = await fetchWithTimeout(link, { redirect: "follow" }, FETCH_TIMEOUT);
    const final = res.url || link;
    const text = await res.text().catch(()=>"");
    if (final && final !== link) return { bypassed: final, method: "redirect", raw: text.slice(0,2000) };
    try {
      const j = JSON.parse(text);
      for (const k of ["bypassed","url","target","redirect","result","data"]) {
        if (j && typeof j === "object" && k in j && typeof j[k] === "string") {
          return { bypassed: j[k], method: "json-target", raw: JSON.stringify(j).slice(0,2000) };
        }
      }
    } catch {}
    return { bypassed: null, raw: text.slice(0,2000) };
  } catch (err) {
    return { bypassed: null, error: String(err) };
  }
}

// call external APIs (placeholder / ?url= / POST fallback)
async function callExternalApi(apiBase, paramName, link, extraHeaders={}) {
  const encoded = encodeURIComponent(link);
  const tryFetch = async (fullUrl, method="GET", body=null, headers={}) => {
    const opts = { method, headers: { "User-Agent": "solver/1.0", "Accept": "application/json, text/plain, */*", ...extraHeaders, ...headers } };
    if (body) opts.body = body;
    const res = await fetchWithTimeout(fullUrl, opts, FETCH_TIMEOUT);
    const text = await res.text().catch(()=> "");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, text, parsed, usedUrl: fullUrl, method };
  };

  if (apiBase.includes("{link}") || apiBase.includes("{url}")) {
    const full = apiBase.replace(/{link}/g, encoded).replace(/{url}/g, encoded);
    return await tryFetch(full);
  }

  const paramRegex = new RegExp(`[?&]${paramName}=`, "i");
  if (paramRegex.test(apiBase)) {
    if (apiBase.endsWith("=")) return await tryFetch(apiBase + encoded);
    const sep = apiBase.includes("?") ? "&" : "?";
    return await tryFetch(apiBase + sep + paramName + "=" + encoded);
  }

  const sep = apiBase.includes("?") ? "&" : "?";
  const full = apiBase + sep + paramName + "=" + encoded;
  let got = await tryFetch(full);
  if ((got.parsed && Object.keys(got.parsed).length) || (got.text && got.text.trim())) return got;
  const postBody = `${encodeURIComponent(paramName)}=${encodeURIComponent(link)}`;
  const postRes = await tryFetch(apiBase, "POST", postBody, { "Content-Type": "application/x-www-form-urlencoded" });
  return postRes;
}

// Playwright fallback
async function playwrightBypass(link) {
  await pwSem.acquire();
  try {
    if (!playwrightBrowser) {
      playwrightBrowser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    }
    const context = await playwrightBrowser.newContext({ userAgent: "Mozilla/5.0 (compatible; solver/1.0)" });
    const page = await context.newPage();
    try {
      await page.goto(link, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>null);
      await page.waitForTimeout(PLAYWRIGHT_WAIT_MS);
      const final = page.url();
      const html = await page.content().catch(()=>"");
      return { bypassed: final, method: "playwright", raw: html.slice(0,3000) };
    } finally {
      await page.close();
      await context.close();
    }
  } catch (err) {
    return { bypassed: null, error: String(err) };
  } finally {
    pwSem.release();
  }
}

// extract candidate link
function extractCandidate(parsed, text, preferredKey="bypassed") {
  if (parsed && typeof parsed === "object") {
    if (preferredKey) {
      const parts = preferredKey.split(".");
      let cur = parsed;
      for (const p of parts) {
        if (cur && typeof cur === "object" && p in cur) cur = cur[p];
        else { cur = null; break; }
      }
      if (typeof cur === "string" && cur.trim()) return cur;
    }
    for (const k of ["bypassed","result","url","data","target","redirect"]) {
      if (k in parsed) {
        const v = parsed[k];
        if (typeof v === "string" && v.trim()) return v;
        if (v && typeof v === "object" && v.url) return v.url;
      }
    }
    const s = JSON.stringify(parsed);
    const m = s.match(/https?:\/\/[^\s'"]{6,}/);
    if (m) return m[0];
  }
  if (text && typeof text === "string") {
    const m = text.match(/https?:\/\/[^\s'"]{6,}/);
    if (m) return m[0];
  }
  return null;
}

// per-link in-progress map & cache
const cacheMap = new Map();
const inProgress = new Map();

async function processLink(link, opts={}) {
  if (!link) return { bypassed: null, error: "missing link" };
  if (cache.has(link)) return { ...cache.get(link), fromCache: true };
  if (inProgress.has(link)) return inProgress.get(link);

  const promise = (async () => {
    try {
      // domain extractor
      const ext = await domainExtractor(link);
      if (ext && ext.bypassed) { cache.set(link, ext); return { ...ext, source: "extractor" }; }

      // follow redirects
      const red = await tryFollowRedirect(link);
      if (red && red.bypassed) { cache.set(link, red); return { ...red, source: "redirect" }; }

      // external APIs (optional)
      if (ENABLE_EXTERNAL_APIS) {
        try {
          const a = await callExternalApi(ABYSM_API, "url", link);
          const candidate = extractCandidate(a.parsed, a.text, opts.json_result || "bypassed");
          if (candidate) { const out = { bypassed: candidate, method: "abysm", raw: a.text.slice(0,3000) }; cache.set(link, out); return out; }
        } catch(e){}
        try {
          const t = await callExternalApi(TRW_API, "url", link);
          const candidate = extractCandidate(t.parsed, t.text, opts.json_result || "bypassed");
          if (candidate) { const out = { bypassed: candidate, method: "trw", raw: t.text.slice(0,3000) }; cache.set(link, out); return out; }
        } catch(e){}
      }

      // Playwright fallback
      const pw = await playwrightBypass(link);
      if (pw && pw.bypassed) { cache.set(link, pw); return pw; }

      return { bypassed: null, error: "Link not supported or API is down" };
    } finally {
      inProgress.delete(link);
    }
  })();

  inProgress.set(link, promise);
  return promise;
}

// routes
app.post("/bypass", async (req, res) => {
  try {
    const { url, preferExternal=false, json_result } = req.body || {};
    if (!url) return res.status(400).json({ error: "url required" });
    const out = await processLink(String(url).trim(), { preferExternal, json_result });
    return res.json(out);
  } catch (err) {
    console.error("/bypass error", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

// graceful shutdown
async function shutdown() {
  try { if (playwrightBrowser) await playwrightBrowser.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// start
app.listen(PORT, () => {
  console.log(`Solver running on :${PORT} (ENABLE_EXTERNAL_APIS=${ENABLE_EXTERNAL_APIS}; PW_CONCURRENCY=${PLAYWRIGHT_CONCURRENCY})`);
});
