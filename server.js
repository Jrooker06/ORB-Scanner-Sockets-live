/**
 * server.js — Polygon proxy (intraday snapshot gainers + REST + WS passthrough)
 *
 * Routes:
 *   GET  /health
 *   GET  /api                            -> Route manifest + version (no token)
 *   GET  /api/health                    -> Health check for scanner compatibility
 *   GET  /api/gainers                   -> Top gainers for scanner (formatted)
 *   GET  /api/float/:symbol             -> Free float (Massive); fallback Polygon ticker overview
 *   GET  /api/historical/:symbol        -> Historical price data
 *   GET  /api/news/:symbol              -> News via Massive (?source=benzinga|stocks, ?limit=N)
 *   GET  /api/shared-tickers            -> Get all shared tickers (clears at 6 PM EST)
 *   POST /api/shared-tickers            -> Add a shared ticker (developer mode only)
 *   DELETE /api/shared-tickers/:symbol  -> Remove a shared ticker
 *   GET  /gainers                       -> Intraday top gainers (snapshot API) w/ grouped fallback
 *   GET  /market/top-gainers            -> Alias of /gainers
 *   GET  /symbol/:symbol                -> Polygon symbol snapshot passthrough
 *   GET  /ohlcv/:symbol                 -> Aggregates with optional session filter (pre/rth/post/all)
 *   GET  /price/:symbol                 -> Latest price (minute aggs -> snapshot fallback)
 *   GET  /previous_close/:symbol        -> Previous close
 *   GET  /historical/:symbol            -> Day/Minute historical (for scanners)
 *   GET  /quote/:symbol                 -> Quote shape used by the clean scanner
 *   WS   /ws                            -> Polygon WS passthrough
 *
 * Env:
 *   POLYGON_API_KEY           (required)
 *   MASSIVE_API_BASE_URL      (optional) Massive REST base; default https://api.massive.com
 *   MASSIVE_API_KEY           (optional) Massive key; default POLYGON_API_KEY
 *   NEWS_CACHE_BENZINGA_SEC   (optional) News cache TTL seconds for Benzinga; default 30
 *   NEWS_CACHE_STOCKS_SEC     (optional) News cache TTL seconds for Stocks news; default 180
 *   NEWS_RATE_LIMIT_PER_MIN   (optional) Max /api/news requests per IP per minute; default 60
 *   NEWS_RATE_MAP_MAX         (optional) Max IP entries in news rate map; default 10000 (prune when over)
 *   FUND_CACHE_MAX           (optional) Max entries in fundamentals cache; default 5000
 *   NEWS_CACHE_MAX           (optional) Max entries in news cache; default 2000
 *   TRUST_PROXY              (optional) Set to 1 or true when behind nginx/load balancer so req.ip is correct
 *   SHUTDOWN_GRACE_MS        (optional) Grace period before force-exit on SIGTERM/SIGINT; default 10000
 *   PORT                     (default 8080)
 */

try { require("dotenv").config(); } catch (_) {}

const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

// --- App setup ---
const app = express();
if (process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
if (!POLYGON_API_KEY) throw new Error("POLYGON_API_KEY is not set");
// Massive — Float + News (Benzinga / Stocks). Default native Massive host; set MASSIVE_API_BASE_URL for Polygon-hosted.
const MASSIVE_API_BASE = (process.env.MASSIVE_API_BASE_URL || "https://api.massive.com").replace(/\/$/, "");
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY || POLYGON_API_KEY;

// --- Security middleware ---
// App token middleware for stock endpoints (protects Polygon quota)
const APP_TOKEN = process.env.APP_TOKEN;
const isProduction = process.env.NODE_ENV === "production";
if (isProduction && !APP_TOKEN) {
  throw new Error("APP_TOKEN is required in production. Set APP_TOKEN in env.");
}
function requireAppToken(req, res, next) {
  if (req.path === "/api/health" || req.path === "/health" || req.path === "/api") return next();
  if (!APP_TOKEN) return next();
  const token = req.headers["x-app-token"];
  if (token !== APP_TOKEN) {
    return res.status(401).json({ error: "Unauthorized", message: "Missing or invalid x-app-token header" });
  }
  next();
}

app.use(requireAppToken);

// Request logging: method, path, status, duration (no bodies/tokens)
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Ticker validation: 1–10 uppercase letters or BRK.B-style (e.g. BRK.B)
const TICKER_REGEX = /^[A-Z]{1,10}$|^[A-Z]{1,5}\.[A-Z]{1,4}$/;
function validTicker(s) {
  const t = String(s || "").toUpperCase();
  return t.length >= 1 && t.length <= 12 && TICKER_REGEX.test(t);
}

// Validate :symbol on all routes that use it (returns 400 if invalid)
app.param("symbol", (req, res, next, symbol) => {
  const t = String(symbol || "").toUpperCase();
  if (!validTicker(t)) {
    return res.status(400).json({ error: "Invalid symbol", symbol: t });
  }
  next();
});

// In-memory rate limit for /api/news (per IP). Prune stale entries when over cap.
const NEWS_RATE_WINDOW_MS = 60 * 1000;
const NEWS_RATE_MAX = parseInt(process.env.NEWS_RATE_LIMIT_PER_MIN, 10) || 60;
const NEWS_RATE_MAP_MAX = parseInt(process.env.NEWS_RATE_MAP_MAX, 10) || 10000;
const newsRateMap = new Map();
function checkNewsRateLimit(ip) {
  const n = Date.now();
  if (newsRateMap.size > NEWS_RATE_MAP_MAX) {
    for (const [k, rec] of newsRateMap.entries()) {
      if (n - rec.since > NEWS_RATE_WINDOW_MS) newsRateMap.delete(k);
    }
  }
  let rec = newsRateMap.get(ip);
  if (!rec) {
    newsRateMap.set(ip, { count: 1, since: n });
    return true;
  }
  if (n - rec.since > NEWS_RATE_WINDOW_MS) {
    rec = { count: 1, since: n };
    newsRateMap.set(ip, rec);
    return true;
  }
  rec.count += 1;
  if (rec.count > NEWS_RATE_MAX) return false;
  return true;
}

// Node >=18 has global fetch

// --- Helpers ---------------------------------------------------------------
async function makePolygonRequest(path, params = {}) {
  const base = "https://api.polygon.io";
  const qs = new URLSearchParams({ ...params, apiKey: POLYGON_API_KEY }).toString();
  const url = `${base}${path}?${qs}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Polygon ${resp.status}: ${text || resp.statusText}`);
  }
  return resp.json();
}

// Massive REST (Float, News, Benzinga) — https://massive.com/docs
async function makeMassiveRequest(path, params = {}) {
  const qs = new URLSearchParams({ ...params, apiKey: MASSIVE_API_KEY }).toString();
  const url = `${MASSIVE_API_BASE}${path}?${qs}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Massive ${resp.status}: ${text || resp.statusText}`);
  }
  return resp.json();
}

// ---------- Fundamentals (optional enrichment) ----------
const FUND_CACHE = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;
const FUND_CACHE_MAX = parseInt(process.env.FUND_CACHE_MAX, 10) || 5000;
const now = () => Date.now();

function cacheGet(key) {
  const hit = FUND_CACHE.get(key);
  if (!hit) return null;
  if (hit.exp < now()) { FUND_CACHE.delete(key); return null; }
  return hit.val;
}
function cacheSet(key, val, ttl = TTL_MS) {
  if (FUND_CACHE.size >= FUND_CACHE_MAX && !FUND_CACHE.has(key)) {
    let minKey = null, minExp = Infinity;
    for (const [k, v] of FUND_CACHE.entries()) {
      if (v.exp < minExp) { minExp = v.exp; minKey = k; }
    }
    if (minKey != null) FUND_CACHE.delete(minKey);
  }
  FUND_CACHE.set(key, { val, exp: now() + ttl });
}

// ---------- News cache (source + ticker + limit + cursor in key) ----------
const NEWS_CACHE = new Map();
const BENZINGA_TTL_MS = (parseInt(process.env.NEWS_CACHE_BENZINGA_SEC, 10) || 30) * 1000;
const STOCKS_NEWS_TTL_MS = (parseInt(process.env.NEWS_CACHE_STOCKS_SEC, 10) || 180) * 1000;
const NEWS_CACHE_MAX = parseInt(process.env.NEWS_CACHE_MAX, 10) || 2000;

function newsCacheGet(key) {
  const hit = NEWS_CACHE.get(key);
  if (!hit) return null;
  if (hit.exp < now()) { NEWS_CACHE.delete(key); return null; }
  return hit.val;
}
function newsCacheSet(key, val, ttlMs) {
  if (NEWS_CACHE.size >= NEWS_CACHE_MAX && !NEWS_CACHE.has(key)) {
    let minKey = null, minExp = Infinity;
    for (const [k, v] of NEWS_CACHE.entries()) {
      if (v.exp < minExp) { minExp = v.exp; minKey = k; }
    }
    if (minKey != null) NEWS_CACHE.delete(minKey);
  }
  NEWS_CACHE.set(key, { val, exp: now() + ttlMs });
}

// limit concurrency for N async jobs
async function limitedMap(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx).catch(() => null);
    }
  });
  await Promise.all(runners);
  return out;
}

async function getTickerOverview(ticker) {
  const key = `ovr:${ticker}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const data = await makePolygonRequest(`/v3/reference/tickers/${encodeURIComponent(ticker)}`);
  const r = data?.results || {};
  const out = {
    sector: r.sic_description || null,
    sicCode: r.sic_code || null,
    marketCap: r.market_cap ?? null,
    weightedSharesOut: r.weighted_shares_outstanding ?? null,
    shareClassSharesOut: r.share_class_shares_outstanding ?? null
  };
  cacheSet(key, out);
  return out;
}

// ---------- NY-market calendar helpers ----------
function ymdNY(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const da = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${da}`; // YYYY-MM-DD
}
function addDays(d, days) { return new Date(d.getTime() + days * 86400000); }

async function fetchGrouped(dateStr) {
  return await makePolygonRequest(`/v2/aggs/grouped/locale/us/market/stocks/${dateStr}`, {
    adjusted: true,
    limit: 50000,
  });
}

// Walk back up to N NY-calendar days to find a trading day with grouped results
async function findLastTradingDayNY(maxBack = 5) {
  let d = new Date();
  for (let i = 0; i < maxBack; i++) {
    const dateStr = ymdNY(d);
    const grouped = await fetchGrouped(dateStr);
    if (grouped?.results?.length) return { dateStr, grouped };
    d = addDays(d, -1);
  }
  // If nothing found, return "yesterday" with empty results
  return { dateStr: ymdNY(addDays(new Date(), -1)), grouped: { results: [] } };
}

// ----- Previous-day gainers (fallback) -----
async function computeGainers(limit = 50) {
  const { dateStr, grouped } = await findLastTradingDayNY(5);
  const rows = (grouped?.results || [])
    .filter(r => r && typeof r.o === "number" && r.o > 0 && typeof r.c === "number")
    .map(r => {
      const pct = (r.c - r.o) / r.o;
      return {
        ticker: r.T,
        open: r.o,
        close: r.c,
        change: +(r.c - r.o).toFixed(4),
        pctChange: +((pct) * 100).toFixed(2),
        volume: r.v,
        date: dateStr,
      };
    })
    .sort((a, b) => b.pctChange - a.pctChange)
    .slice(0, Math.min(limit, 500));
  return { date: dateStr, results: rows, source: "grouped" };
}

// ----- Intraday snapshot gainers (real-time-ish) -----
async function computeSnapshotGainers(limit = 50) {
  // Polygon snapshots: /v2/snapshot/locale/us/markets/stocks/gainers
  const data = await makePolygonRequest(`/v2/snapshot/locale/us/markets/stocks/gainers`);

  const rows = (data?.tickers || data?.results || [])
    .map(r => {
      // Support both "tickers" shape and older "results" shape
      const tkr = r.ticker || r.T || r.symbol;
      const last = r.lastTrade?.p ?? r.last?.price ?? r.lastQuote?.p ?? null;
      const prev = r.prevDay?.c ?? r.prevClose ?? r.day?.o ?? null;
      const todaysChange = r.todaysChange ?? (last != null && prev != null ? +(last - prev).toFixed(4) : null);
      const todaysChangePerc = r.todaysChangePerc ?? (
        last != null && prev ? +(((last - prev) / prev) * 100).toFixed(2) : null
      );
      const vol = r.day?.v ?? r.volume ?? null;

      return {
        ticker: tkr,
        last,
        previousClose: prev,
        change: todaysChange,
        pctChange: todaysChangePerc,
        volume: vol,
        raw: r
      };
    })
    .filter(x => x.ticker && x.pctChange != null)
    .sort((a, b) => (b.pctChange ?? -Infinity) - (a.pctChange ?? -Infinity))
    .slice(0, Math.min(limit, 500));

  return { date: new Date().toISOString(), results: rows, source: "snapshot" };
}

// --- Route manifest (version + overview for clients) -----------------------
const API_VERSION = "1.0.4";
const ROUTE_MANIFEST = [
  { method: "GET", path: "/health", desc: "Basic health" },
  { method: "GET", path: "/api", desc: "Route manifest + version" },
  { method: "GET", path: "/api/health", desc: "Health + services + version" },
  { method: "GET", path: "/api/gainers", desc: "Top gainers (scanner)" },
  { method: "GET", path: "/api/float/:symbol", desc: "Free float (Massive); ?cursor=" },
  { method: "GET", path: "/api/historical/:symbol", desc: "Historical price data" },
  { method: "GET", path: "/api/news/:symbol", desc: "News; ?source=benzinga|stocks&limit=&cursor=" },
  { method: "GET", path: "/api/shared-tickers", desc: "List shared tickers" },
  { method: "POST", path: "/api/shared-tickers", desc: "Add shared ticker (developer)" },
  { method: "DELETE", path: "/api/shared-tickers/:symbol", desc: "Remove shared ticker" },
  { method: "GET", path: "/gainers", desc: "Intraday top gainers" },
  { method: "GET", path: "/market/top-gainers", desc: "Alias of /gainers" },
  { method: "GET", path: "/symbol/:symbol", desc: "Polygon snapshot" },
  { method: "GET", path: "/ohlcv/:symbol", desc: "Aggregates; ?session=pre|rth|post|all" },
  { method: "GET", path: "/price/:symbol", desc: "Latest price" },
  { method: "GET", path: "/previous_close/:symbol", desc: "Previous close" },
  { method: "GET", path: "/historical/:symbol", desc: "Day/minute historical" },
  { method: "GET", path: "/quote/:symbol", desc: "Quote (scanner)" },
  { method: "WS", path: "/ws", desc: "Polygon WS passthrough" },
];

// --- Routes ----------------------------------------------------------------

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, status: "ok", message: "Server is running", timestamp: new Date().toISOString() });
});

// Route manifest + version (GET /api)
app.get("/api", (_req, res) => {
  res.json({ version: API_VERSION, routes: ROUTE_MANIFEST });
});

// API Health endpoint - safe, public endpoint with no secrets
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    env: process.env.NODE_ENV || "production",
    services: {
      dialogflow: !!(process.env.DIALOGFLOW_PROJECT_ID && process.env.DIALOGFLOW_PRIVATE_KEY && process.env.DIALOGFLOW_CLIENT_EMAIL),
      groq: !!process.env.AI_COMPAT_API_KEY,
      polygon: !!process.env.POLYGON_API_KEY,
      encryption: !!process.env.ENCRYPTION_KEY,
      massive: !!(process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY),
      massiveBase: process.env.MASSIVE_API_BASE_URL || null,
      benzinga: !!(process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY),
    },
    version: API_VERSION,
    routes: ROUTE_MANIFEST,
    timestamp: new Date().toISOString(),
  });
});

// API Config endpoint - SECURITY: Only mounted if ADMIN_TOKEN is set in production
// In production without ADMIN_TOKEN: route is not mounted (returns 404)
// In production with ADMIN_TOKEN: requires x-admin-token header matching ADMIN_TOKEN
// In development: always available (for debugging)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const isDevelopment = process.env.NODE_ENV !== 'production';

if (isDevelopment || ADMIN_TOKEN) {
  app.get("/api/config", (req, res) => {
    // In production, require admin token
    if (!isDevelopment) {
      const adminToken = req.headers['x-admin-token'];
      if (adminToken !== ADMIN_TOKEN) {
        return res.status(401).json({ 
          error: "Unauthorized",
          message: "Missing or invalid x-admin-token header. Header value must equal ADMIN_TOKEN."
        });
      }
    }
    
    // Redact sensitive values - only show last 4 chars
    function redact(value) {
      if (!value || typeof value !== 'string') return null;
      if (value.length <= 4) return '****';
      return '****' + value.slice(-4);
    }
    
    res.json({
      // Dialogflow Configuration (redacted)
      dialogflow: {
        projectId: process.env.DIALOGFLOW_PROJECT_ID || null,
        clientEmail: process.env.DIALOGFLOW_CLIENT_EMAIL || null,
        privateKey: redact(process.env.DIALOGFLOW_PRIVATE_KEY),
      },
      // Encryption (redacted)
      encryption: {
        key: redact(process.env.ENCRYPTION_KEY),
      },
      // Groq AI API Configuration (redacted)
      ai: {
        apiKey: redact(process.env.AI_COMPAT_API_KEY),
        baseUrl: process.env.AI_COMPAT_BASE_URL || 'https://api.groq.com/openai/v1',
        model: process.env.AI_COMPAT_MODEL || 'llama-3.3-70b-versatile',
      },
      // Server Configuration (safe to show)
      server: {
        port: process.env.PORT || 3000,
        nodeEnv: process.env.NODE_ENV || 'production',
      },
      // CORS Configuration (safe to show)
      cors: {
        wixSiteUrl: process.env.WIX_SITE_URL || null,
        frontendUrl: process.env.FRONTEND_URL || null,
      },
      timestamp: new Date().toISOString(),
      warning: "This endpoint should only be used in development. Secrets are redacted.",
    });
  });
}
// If ADMIN_TOKEN is not set in production, /api/config is not mounted (returns 404)

// ----- API endpoints for scanner compatibility -----
app.get("/api/gainers", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10) || 50, 500);
    const seen = new Set();
    const tickers = [];

    // 1) Snapshot returns only ~20 tickers (Polygon limit). Get live top gainers first.
    try {
      const snapshot = await computeSnapshotGainers(limit);
      for (const row of snapshot.results || []) {
        if (row.ticker && !seen.has(row.ticker)) {
          seen.add(row.ticker);
          tickers.push({
            ticker: row.ticker,
            price: row.last || row.close,
            change: row.change,
            change_pct: row.pctChange,
            volume: row.volume
          });
        }
      }
    } catch (_) { /* snapshot failed, will use grouped only */ }

    // 2) If we need more tickers (e.g. scanner asked for 500), fill from grouped/day gainers.
    if (tickers.length < limit) {
      const grouped = await computeGainers(limit);
      for (const row of grouped.results || []) {
        if (tickers.length >= limit) break;
        if (row.ticker && !seen.has(row.ticker)) {
          seen.add(row.ticker);
          tickers.push({
            ticker: row.ticker,
            price: row.close,
            change: row.change,
            change_pct: row.pctChange,
            volume: row.volume
          });
        }
      }
    }

    res.json({ tickers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Massive Float: https://massive.com/docs/rest/stocks/fundamentals/float
// Returns free_float, free_float_percent, effective_date, ticker. Falls back to Polygon ticker overview if Massive fails.
// Query: ?cursor= forwarded to Massive. If Massive expects the full next_url as the next request URL, call that URL directly or pass it as cursor per their docs.
app.get("/api/float/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const ticker = String(symbol).toUpperCase();
    const cursor = req.query.cursor || undefined;
    const cacheKey = cursor ? null : `float:${ticker}`;
    if (cacheKey) {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
    }

    try {
      const params = { ticker, limit: 1 };
      if (cursor) params.cursor = cursor;
      const data = await makeMassiveRequest("/stocks/v1/float", params);
      const results = (data?.results || [])[0] ?? null;
      const out = results
        ? {
            ticker,
            results: {
              ticker: results.ticker,
              free_float: results.free_float,
              free_float_percent: results.free_float_percent,
              effective_date: results.effective_date,
            },
            next_url: data?.next_url ?? null,
            source: "massive",
          }
        : { ticker, results: null, next_url: data?.next_url ?? null, source: "massive" };
      if (results && !cursor) cacheSet(cacheKey, out);
      return res.json(out);
    } catch (_) {
      const overview = await getTickerOverview(symbol);
      return res.json({ ticker, results: overview, source: "polygon" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/historical/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { days_back = 0, interval = "1" } = req.query;
    
    // Calculate date range
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - parseInt(days_back));
    
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${interval}/minute/${start.toISOString().split('T')[0]}/${end.toISOString().split('T')[0]}`,
      { adjusted: true, sort: "asc", limit: 5000 }
    );
    
    const results = (data?.results || []).map(bar => ({
      t: bar.t,  // timestamp
      o: bar.o,  // open
      h: bar.h,  // high
      l: bar.l,  // low
      c: bar.c,  // close
      v: bar.v,  // volume
      n: bar.n   // transactions
    }));
    
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// News: Benzinga (primary) or Stocks News via Massive. https://massive.com/docs/rest/partners/benzinga/news and /rest/stocks/news
// Query: ?source=benzinga|stocks (default benzinga), ?limit=10, ?cursor= forwarded to Massive. If responses use next_url as full URL for "next page", use that URL per Massive docs.
// Rate-limited per IP; cached (Benzinga ~30s, Stocks ~3min). Symbol validated.
app.get("/api/news/:symbol", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (!checkNewsRateLimit(ip)) {
    return res.status(429).json({ error: "Too many requests", message: "News rate limit exceeded. Try again later." });
  }
  try {
    const { symbol } = req.params;
    const ticker = String(symbol).toUpperCase();
    const source = (req.query.source || "benzinga").toLowerCase();
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, source === "benzinga" ? 100 : 1000);
    const cursor = req.query.cursor || undefined;
    const cacheKey = cursor ? null : `news:${source}:${ticker}:${limit}`;
    if (cacheKey) {
      const ttl = source === "benzinga" ? BENZINGA_TTL_MS : STOCKS_NEWS_TTL_MS;
      const cached = newsCacheGet(cacheKey);
      if (cached) return res.json(cached);
    }

    if (source === "stocks") {
      const params = { ticker, limit, sort: "published_utc", order: "desc" };
      if (cursor) params.cursor = cursor;
      const data = await makeMassiveRequest("/v2/reference/news", params);
      const results = (data?.results || []).map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        published_utc: r.published_utc || r.published || null,
        article_url: r.article_url,
        description: r.description,
        image_url: r.image_url,
        tickers: r.tickers,
        publisher: r.publisher,
      }));
      const out = {
        ticker,
        results,
        count: data?.count ?? results.length,
        next_url: data?.next_url ?? null,
        source: "stocks",
      };
      if (!cursor) newsCacheSet(cacheKey, out, STOCKS_NEWS_TTL_MS);
      return res.json(out);
    }

    const params = { tickers: ticker, limit, sort: "published.desc" };
    if (cursor) params.cursor = cursor;
    const data = await makeMassiveRequest("/benzinga/v2/news", params);
    const results = (data?.results || []).map((r) => ({
      benzinga_id: r.benzinga_id,
      title: r.title,
      author: r.author,
      published: r.published,
      published_utc: r.published_utc || r.published || null,
      last_updated: r.last_updated,
      url: r.url,
      teaser: r.teaser,
      body: r.body,
      tickers: r.tickers,
      channels: r.channels,
      tags: r.tags,
      images: r.images,
    }));
    const out = { ticker, results, next_url: data?.next_url ?? null, source: "benzinga" };
    if (!cursor) newsCacheSet(cacheKey, out, BENZINGA_TTL_MS);
    return res.json(out);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----- Additional Scanner Endpoints -----

// Real-time price updates for live monitoring
app.get("/api/price/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const data = await makePolygonRequest(
      `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`
    );
    
    const price = data?.ticker?.lastTrade?.p ?? data?.results?.lastTrade?.p ?? null;
    const volume = data?.ticker?.day?.v ?? data?.results?.day?.v ?? null;
    const change = data?.ticker?.todaysChange ?? data?.results?.todaysChange ?? null;
    const changePct = data?.ticker?.todaysChangePerc ?? data?.results?.todaysChangePerc ?? null;
    
    res.json({
      symbol,
      price,
      volume,
      change,
      change_pct: changePct,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Volume analysis for volume-based scanning
app.get("/api/volume/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { days_back = 1 } = req.query;
    
    const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${dateStr}/${dateStr}`,
      { adjusted: true, sort: "desc", limit: 1000 }
    );
    
    const results = (data?.results || []).map(bar => ({
      timestamp: bar.t,
      volume: bar.v,
      price: bar.c
    }));
    
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Market status and session info for timing decisions
app.get("/api/market/status", async (req, res) => {
  try {
    const now = new Date();
    const nyTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const hour = nyTime.getHours();
    const minute = nyTime.getMinutes();
    
    let session = "closed";
    if (hour >= 9 && hour < 16) session = "regular";
    else if (hour >= 4 && hour < 9) session = "premarket";
    else if (hour >= 16 && hour < 20) session = "afterhours";
    
    res.json({
      session,
      time: nyTime.toISOString(),
      is_market_open: session === "regular",
      next_open: "09:30",
      next_close: "16:00"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// RSI calculation for technical analysis
app.get("/api/rsi/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { period = 14, days_back = 30 } = req.query;
    
    const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${dateStr}/${dateStr}`,
      { adjusted: true, sort: "desc", limit: period + 10 }
    );
    
    // Calculate RSI
    const prices = (data?.results || []).map(bar => bar.c).reverse();
    const rsi = calculateRSI(prices, parseInt(period));
    
    res.json({ rsi, period, symbol });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// VWAP calculation for price analysis
app.get("/api/vwap/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { days_back = 1 } = req.query;
    
    const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${dateStr}/${dateStr}`,
      { adjusted: true, sort: "asc", limit: 1000 }
    );
    
    const results = data?.results || [];
    if (results.length === 0) {
      return res.json({ vwap: null, symbol });
    }
    
    // Calculate VWAP
    let totalVolume = 0;
    let totalVolumePrice = 0;
    
    results.forEach(bar => {
      const typicalPrice = (bar.h + bar.l + bar.c) / 3;
      totalVolumePrice += typicalPrice * bar.v;
      totalVolume += bar.v;
    });
    
    const vwap = totalVolume > 0 ? totalVolumePrice / totalVolume : null;
    
    res.json({ 
      vwap: vwap ? parseFloat(vwap.toFixed(4)) : null, 
      symbol,
      data_points: results.length 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// MACD calculation for trend analysis
app.get("/api/macd/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { fast = 12, slow = 26, signal = 9, days_back = 60 } = req.query;
    
    const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${dateStr}/${dateStr}`,
      { adjusted: true, sort: "desc", limit: Math.max(fast, slow, signal) + 20 }
    );
    
    const prices = (data?.results || []).map(bar => bar.c).reverse();
    if (prices.length < Math.max(fast, slow, signal)) {
      return res.json({ error: "Insufficient data for MACD calculation" });
    }
    
    const macd = calculateMACD(prices, parseInt(fast), parseInt(slow), parseInt(signal));
    
    res.json({ 
      macd, 
      symbol, 
      fast_period: parseInt(fast), 
      slow_period: parseInt(slow), 
      signal_period: parseInt(signal) 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Support and Resistance levels
app.get("/api/support-resistance/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { days_back = 30 } = req.query;
    
    const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${dateStr}/${dateStr}`,
      { adjusted: true, sort: "desc", limit: parseInt(days_back) }
    );
    
    const prices = (data?.results || []).map(bar => bar.h);
    const lows = (data?.results || []).map(bar => bar.l);
    
    if (prices.length === 0) {
      return res.json({ support: null, resistance: null, symbol });
    }
    
    // Simple support and resistance calculation
    const resistance = Math.max(...prices);
    const support = Math.min(...lows);
    
    res.json({ 
      support: parseFloat(support.toFixed(4)), 
      resistance: parseFloat(resistance.toFixed(4)), 
      symbol,
      data_points: prices.length 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// EMA9 calculation for short-term trend
app.get("/api/ema9/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { days_back = 30 } = req.query;
    
    // Try daily data first
    let prices = [];
    try {
      const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
      const data = await makePolygonRequest(
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${dateStr}/${dateStr}`,
        { adjusted: true, sort: "desc", limit: parseInt(days_back) }
      );
      prices = (data?.results || []).map(bar => bar.c).reverse();
    } catch (_) {}
    
    // If daily data insufficient, try minute data for today
    if (prices.length < 9) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const data = await makePolygonRequest(
          `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${today}/${today}`,
          { adjusted: true, sort: "asc", limit: 1000 }
        );
        prices = (data?.results || []).map(bar => bar.c);
      } catch (_) {}
    }
    
    if (prices.length < 9) {
      return res.json({ error: "Insufficient data for EMA9 calculation (need at least 9 data points)" });
    }
    
    const ema9 = calculateEMA(prices, 9);
    
    res.json({ 
      ema9: parseFloat(ema9.toFixed(4)), 
      symbol,
      period: 9,
      data_points: prices.length,
      current_price: prices[prices.length - 1],
      above_ema9: prices[prices.length - 1] > ema9,
      data_source: prices.length > 100 ? "minute" : "daily"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// EMA21 calculation for medium-term trend
app.get("/api/ema21/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { days_back = 60 } = req.query;
    
    // Try daily data first
    let prices = [];
    try {
      const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
      const data = await makePolygonRequest(
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${dateStr}/${dateStr}`,
        { adjusted: true, sort: "desc", limit: parseInt(days_back) }
      );
      prices = (data?.results || []).map(bar => bar.c).reverse();
    } catch (_) {}
    
    // If daily data insufficient, try minute data for today
    if (prices.length < 21) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const data = await makePolygonRequest(
          `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${today}/${today}`,
          { adjusted: true, sort: "asc", limit: 1000 }
        );
        prices = (data?.results || []).map(bar => bar.c);
      } catch (_) {}
    }
    
    if (prices.length < 21) {
      return res.json({ error: "Insufficient data for EMA21 calculation (need at least 21 data points)" });
    }
    
    const ema21 = calculateEMA(prices, 21);
    
    res.json({ 
      ema21: parseFloat(ema21.toFixed(4)), 
      symbol,
      period: 21,
      data_points: prices.length,
      current_price: prices[prices.length - 1],
      above_ema21: prices[prices.length - 1] > ema21,
      data_source: prices.length > 100 ? "minute" : "daily"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Combined EMA9 and EMA21 for trend analysis
app.get("/api/ema-trend/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { days_back = 60 } = req.query;
    
    // Try daily data first
    let prices = [];
    try {
      const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
      const data = await makePolygonRequest(
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${dateStr}/${dateStr}`,
        { adjusted: true, sort: "desc", limit: parseInt(days_back) }
      );
      prices = (data?.results || []).map(bar => bar.c).reverse();
    } catch (_) {}
    
    // If daily data insufficient, try minute data for today
    if (prices.length < 21) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const data = await makePolygonRequest(
          `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${today}/${today}`,
          { adjusted: true, sort: "asc", limit: 1000 }
        );
        prices = (data?.results || []).map(bar => bar.c);
      } catch (_) {}
    }
    
    if (prices.length < 21) {
      return res.json({ error: "Insufficient data for EMA calculations (need at least 21 data points)" });
    }
    
    const ema9 = calculateEMA(prices, 9);
    const ema21 = calculateEMA(prices, 21);
    const currentPrice = prices[prices.length - 1];
    
    // Determine trend
    let trend = "neutral";
    if (ema9 > ema21 && currentPrice > ema9) {
      trend = "bullish";
    } else if (ema9 < ema21 && currentPrice < ema9) {
      trend = "bearish";
    }
    
    // Check for golden/death cross
    let cross_signal = "none";
    if (prices.length >= 22) {
      const prevEma9 = calculateEMA(prices.slice(0, -1), 9);
      const prevEma21 = calculateEMA(prices.slice(0, -1), 21);
      
      if (ema9 > ema21 && prevEma9 <= prevEma21) {
        cross_signal = "golden_cross"; // EMA9 crossed above EMA21
      } else if (ema9 < ema21 && prevEma9 >= prevEma21) {
        cross_signal = "death_cross"; // EMA9 crossed below EMA21
      }
    }
    
    res.json({ 
      symbol,
      ema9: parseFloat(ema9.toFixed(4)),
      ema21: parseFloat(ema21.toFixed(4)),
      current_price: parseFloat(currentPrice.toFixed(4)),
      trend,
      cross_signal,
      above_ema9: currentPrice > ema9,
      above_ema21: currentPrice > ema21,
      ema9_above_ema21: ema9 > ema21,
      data_points: prices.length,
      data_source: prices.length > 100 ? "minute" : "daily"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// EMA crossover alerts for trading signals
app.get("/api/ema-crossover/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { days_back = 30 } = req.query;
    
    const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${dateStr}/${dateStr}`,
      { adjusted: true, sort: "desc", limit: parseInt(days_back) }
    );
    
    const prices = (data?.results || []).map(bar => bar.c).reverse();
    if (prices.length < 21) {
      return res.json({ error: "Insufficient data for crossover analysis" });
    }
    
    // Calculate EMAs for multiple periods to detect crossovers
    const emaValues = [];
    for (let i = 9; i < prices.length; i++) {
      const ema9 = calculateEMA(prices.slice(0, i + 1), 9);
      const ema21 = calculateEMA(prices.slice(0, i + 1), 21);
      emaValues.push({
        date: i,
        ema9: parseFloat(ema9.toFixed(4)),
        ema21: parseFloat(ema21.toFixed(4)),
        crossover: ema9 > ema21
      });
    }
    
    // Find recent crossovers
    const crossovers = [];
    for (let i = 1; i < emaValues.length; i++) {
      const prev = emaValues[i - 1];
      const curr = emaValues[i];
      
      if (prev.crossover !== curr.crossover) {
        crossovers.push({
          date_index: curr.date,
          type: curr.crossover ? "golden_cross" : "death_cross",
          ema9: curr.ema9,
          ema21: curr.ema21,
          price_at_crossover: prices[curr.date]
        });
      }
    }
    
    res.json({ 
      symbol,
      current_ema9: emaValues[emaValues.length - 1].ema9,
      current_ema21: emaValues[emaValues.length - 1].ema21,
      current_price: prices[prices.length - 1],
      trend: emaValues[emaValues.length - 1].crossover ? "bullish" : "bearish",
      recent_crossovers: crossovers.slice(-3), // Last 3 crossovers
      total_crossovers: crossovers.length,
      data_points: prices.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function for RSI calculation
function calculateRSI(prices, period) {
  if (prices.length < period + 1) return null;
  
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i-1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Helper function for MACD calculation
function calculateMACD(prices, fastPeriod, slowPeriod, signalPeriod) {
  if (prices.length < Math.max(fastPeriod, slowPeriod, signalPeriod)) return null;
  
  // Calculate EMAs
  const fastEMA = calculateEMA(prices, fastPeriod);
  const slowEMA = calculateEMA(prices, slowPeriod);
  
  // Calculate MACD line
  const macdLine = fastEMA - slowEMA;
  
  // Calculate signal line (EMA of MACD line)
  const macdValues = [];
  for (let i = 0; i < prices.length; i++) {
    const fastEMA_i = calculateEMA(prices.slice(0, i + 1), fastPeriod);
    const slowEMA_i = calculateEMA(prices.slice(0, i + 1), slowPeriod);
    macdValues.push(fastEMA_i - slowEMA_i);
  }
  
  const signalLine = calculateEMA(macdValues, signalPeriod);
  const histogram = macdLine - signalLine;
  
  return {
    macd_line: parseFloat(macdLine.toFixed(4)),
    signal_line: parseFloat(signalLine.toFixed(4)),
    histogram: parseFloat(histogram.toFixed(4))
  };
}

// Helper function for EMA calculation
function calculateEMA(prices, period) {
  if (prices.length === 0) return 0;
  
  const multiplier = 2 / (period + 1);
  let ema = prices[0];
  
  for (let i = 1; i < prices.length; i++) {
    ema = (prices[i] * multiplier) + (ema * (1 - multiplier));
  }
  
  return ema;
}

// Full symbol snapshot passthrough
app.get("/symbol/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const data = await makePolygonRequest(
      `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch symbol snapshot", message: String(e.message || e) });
  }
});

// ----- Gainers (prefer intraday snapshots, fallback to grouped previous day) -----
app.get("/gainers", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50", 10);
    const includeFund = /fund|all/i.test(String(req.query.include||""));

    let data;
    try {
      data = await computeSnapshotGainers(limit);   // intraday (live-ish)
    } catch (_) {
      data = await computeGainers(limit);           // fallback
    }

    const rows = data.results;

    if (includeFund && rows.length) {
      await limitedMap(rows, 6, async (row) => {
        const f = await getTickerOverview(row.ticker);
        Object.assign(row, {
          sector: f.sector,
          sicCode: f.sicCode,
          marketCap: f.marketCap,
          sharesOutstanding: f.weightedSharesOut ?? f.shareClassSharesOut
        });
      });
    }

    res.json({ date: data.date, source: data.source, results: rows });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch gainers", message: String(e.message || e) });
  }
});

// alias
app.get("/market/top-gainers", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50", 10);
    const includeFund = /fund|all/i.test(String(req.query.include||""));

    let data;
    try {
      data = await computeSnapshotGainers(limit);
    } catch (_) {
      data = await computeGainers(limit);
    }

    const rows = data.results;

    if (includeFund && rows.length) {
      await limitedMap(rows, 6, async (row) => {
        const f = await getTickerOverview(row.ticker);
        Object.assign(row, {
          sector: f.sector,
          sicCode: f.sicCode,
          marketCap: f.marketCap,
          sharesOutstanding: f.weightedSharesOut ?? f.shareClassSharesOut
        });
      });
    }

    res.json({ date: data.date, source: data.source, results: rows });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch gainers", message: String(e.message || e) });
  }
});

// ----- OHLCV (walk back to last trading day if from/to not given) + session filter -----
app.get("/ohlcv/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const {
      multiplier = 1,
      timespan = "minute",
      from,
      to,
      limit = 5000,
      sort = "asc",
      adjusted = true,
      session = "all" // 'pre' | 'rth' | 'post' | 'all'
    } = req.query;

    let start, end;

    if (from || to) {
      end = to || from;
      start = from || end;
    } else {
      const { dateStr } = await findLastTradingDayNY(5);
      start = end = dateStr;
    }

    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${start}/${end}`,
      { adjusted, sort, limit }
    );

    let rows = Array.isArray(data?.results) ? data.results : [];

    // Session filter (America/New_York)
    if (session !== "all" && rows.length) {
      const inNY = ts => {
        const d = new Date(ts); // ms
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit", minute: "2-digit", hour12: false
        }).formatToParts(d);
        const hh = +parts.find(p => p.type === "hour").value;
        const mm = +parts.find(p => p.type === "minute").value;
        return [hh, mm];
      };
      const isPre  = (h,m) => (h > 3 && (h < 9 || (h === 9 && m < 30)));   // 04:00–09:29
      const isRth  = (h,m) => (h > 9 || (h === 9 && m >= 30)) && h < 16;    // 09:30–15:59
      const isPost = (h,m) => (h >= 16 && h < 20);                          // 16:00–19:59

      rows = rows.filter(bar => {
        const [h, m] = inNY(bar.t);
        if (session === "pre")  return isPre(h,m);
        if (session === "rth")  return isRth(h,m);
        if (session === "post") return isPost(h,m);
        return true;
      });
    }

    res.json({ results: rows });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch OHLCV", message: String(e.message || e) });
  }
});

// ----- Latest price (use last trading day minute bars, then snapshot fallback) -----
app.get("/price/:symbol", async (req, res) => {
  const { symbol } = req.params;
  try {
    let price = null;

    // Try the latest minute bar from the most recent trading day
    try {
      const { dateStr } = await findLastTradingDayNY(5);
      const aggs = await makePolygonRequest(
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${dateStr}/${dateStr}`,
        { adjusted: true, sort: "desc", limit: 1 }
      );
      if (aggs?.results?.length) price = aggs.results[0].c;
    } catch (_) {}

    // Snapshot last trade fallback (handles after-hours / entitlement cases)
    if (price == null) {
      const snap = await makePolygonRequest(
        `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`
      );
      price = snap?.ticker?.lastTrade?.p
           ?? snap?.results?.lastTrade?.p
           ?? snap?.lastTrade?.p
           ?? null;
    }

    res.json({ symbol, price });
  } catch (e) {
    res.status(500).json({ symbol, price: null, error: String(e.message || e) });
  }
});

// Previous close
app.get("/previous_close/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`,
      { adjusted: true }
    );
    const prev = Array.isArray(data?.results) ? data.results[0] : null;
    res.json({ symbol, previousClose: prev?.c ?? null, raw: prev || null });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch previous close", message: String(e.message || e) });
  }
});

// ----- Historical data (for scanners) -----
app.get("/historical/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { days_back = 1, interval = "day" } = req.query;

    // Find the last trading day (walk back a little extra)
    const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);

    // Pull aggregates for that day (Polygon uses 'range/{multiplier}/{timespan}')
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/${interval}/${dateStr}/${dateStr}`,
      { adjusted: true, sort: "desc", limit: 100 }
    );

    // Shape to match clean scanner expectations
    const results = (data?.results || []).map(bar => ({
      c: bar.c,  // close
      o: bar.o,  // open
      h: bar.h,  // high
      l: bar.l,  // low
      v: bar.v,  // volume
      t: bar.t   // timestamp (ms)
    }));

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch historical data", message: String(e.message || e) });
  }
});

// ----- Quote (for the clean scanner) -----
app.get("/quote/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    let price = null;

    // Try the latest minute bar from the most recent trading day
    try {
      const { dateStr } = await findLastTradingDayNY(5);
      const aggs = await makePolygonRequest(
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${dateStr}/${dateStr}`,
        { adjusted: true, sort: "desc", limit: 1 }
      );
      if (aggs?.results?.length) price = aggs.results[0].c;
    } catch (_) {}

    // Snapshot fallback
    if (price == null) {
      const snap = await makePolygonRequest(
        `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`
      );
      price = snap?.ticker?.lastTrade?.p
           ?? snap?.results?.lastTrade?.p
           ?? snap?.lastTrade?.p
           ?? null;
    }

    // Previous close for change calc (optional but provided for parity)
    let prevClose = null;
    try {
      const prevData = await makePolygonRequest(
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`,
        { adjusted: true }
      );
      prevClose = prevData?.results?.[0]?.c ?? null;
    } catch (_) {}

    res.json({
      results: {
        lastTrade: { p: price, s: 0 },
        prevDay: { c: prevClose, o: prevClose, h: prevClose, l: prevClose, v: 0 }
      }
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch quote", message: String(e.message || e) });
  }
});

// --- Shared Tickers (daily ticker sharing) ---
const sharedTickers = new Map(); // symbol -> {symbol, addedAt, addedBy}
let currentTradingDay = ymdNY();

// Helper to check if we're past trading day end (6:00 PM ET)
function getNYTime() {
  const now = new Date();
  return new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function isAfterMarketClose() {
  const nyTime = getNYTime();
  const hour = nyTime.getHours();
  return hour >= 18; // 6:00 PM ET (18:00)
}

// Clear shared tickers at end of trading day
function checkTradingDayReset() {
  const today = ymdNY();
  if (today !== currentTradingDay || isAfterMarketClose()) {
    sharedTickers.clear();
    currentTradingDay = today;
    console.log(`📅 Cleared shared tickers for new trading day: ${today}`);
  }
}

// Helper to check if user is in developer mode (allowed: admin + joeyrooker06 / greenhorizontrading06)
function isDeveloperMode(req) {
  const userEmail = req.headers['x-user-email'] || '';
  const email = userEmail.trim().toLowerCase();
  return (
    email === 'admin@example.com' ||
    email === 'joeyrooker06@gmail.com' ||
    email === 'greenhorizontrading06@gmail.com'
  );
}

// GET /api/shared-tickers - Get all shared tickers
app.get("/api/shared-tickers", (req, res) => {
  try {
    checkTradingDayReset();
    const tickers = Array.from(sharedTickers.values());
    res.json({ success: true, tickers });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch shared tickers", message: String(e.message || e) });
  }
});

// POST /api/shared-tickers - Add a shared ticker (developer mode only)
app.post("/api/shared-tickers", (req, res) => {
  try {
    checkTradingDayReset();
    
    // Check if user is in developer mode
    if (!isDeveloperMode(req)) {
      return res.status(403).json({ error: "Only developer mode can add shared tickers" });
    }
    
    const { symbol } = req.body;
    if (!symbol) {
      return res.status(400).json({ error: "Symbol is required" });
    }
    const ticker = String(symbol).toUpperCase().trim();
    if (!validTicker(ticker)) {
      return res.status(400).json({ error: "Invalid symbol", ticker });
    }
    sharedTickers.set(ticker, {
      symbol: ticker,
      addedAt: new Date().toISOString(),
      addedBy: req.headers['x-user-email'] || 'unknown'
    });
    res.json({ success: true, ticker: sharedTickers.get(ticker) });
  } catch (e) {
    res.status(500).json({ error: "Failed to add shared ticker", message: String(e.message || e) });
  }
});

// DELETE /api/shared-tickers/:symbol - Remove a shared ticker
app.delete("/api/shared-tickers/:symbol", (req, res) => {
  try {
    checkTradingDayReset();
    const { symbol } = req.params;
    const ticker = symbol.toUpperCase().trim();
    if (sharedTickers.delete(ticker)) {
      res.json({ success: true, message: `Removed ${ticker}` });
    } else {
      res.status(404).json({ error: "Ticker not found" });
    }
  } catch (e) {
    res.status(500).json({ error: "Failed to remove shared ticker", message: String(e.message || e) });
  }
});

// Catch-all 404 (JSON; avoids Express default "Cannot GET /…")
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

// --- WebSocket passthrough (optional) --------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/ws") {
    wss.handleUpgrade(request, socket, head, wsClient => {
      wss.emit("connection", wsClient, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (wsClient) => {
  const upstream = new WebSocket("wss://socket.polygon.io/stocks");
  upstream.on("open", () => {
    upstream.send(JSON.stringify({ action: "auth", params: POLYGON_API_KEY }));
  });
  upstream.on("message", (msg) => { try { wsClient.send(msg.toString()); } catch {} });
  wsClient.on("message", (msg) => { try { if (upstream.readyState === WebSocket.OPEN) upstream.send(msg.toString()); } catch {} });
  const cleanup = () => { try { wsClient.close(); } catch {}; try { upstream.close(); } catch {}; };
  wsClient.on("close", cleanup); wsClient.on("error", cleanup);
  upstream.on("close", cleanup); upstream.on("error", cleanup);
});

// --- Start -----------------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ polygon-proxy listening on ${PORT}`);
  console.log(`   GET  http://0.0.0.0:${PORT}/gainers`);
  console.log(`   GET  http://0.0.0.0:${PORT}/api/gainers`);
  console.log(`   WS   ws://0.0.0.0:${PORT}/ws`);
});

// Graceful shutdown: stop accepting new connections, then exit
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS, 10) || 10000;
function shutdown(sig) {
  console.log(`\n${sig} received, closing server…`);
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Shutdown grace period expired, forcing exit.");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
