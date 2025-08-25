/**
 * server.js — Polygon proxy (intraday snapshot gainers + REST + WS passthrough)
 *
 * Routes:
 *   GET  /health
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
 *   POLYGON_API_KEY   (required)
 *   PORT              (default 8080)
 */

try { require("dotenv").config(); } catch (_) {}

const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

// --- App setup ---
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
if (!POLYGON_API_KEY) throw new Error("POLYGON_API_KEY is not set");

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

// ---------- Fundamentals (optional enrichment) ----------
const FUND_CACHE = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;
const now = () => Date.now();

function cacheGet(key) {
  const hit = FUND_CACHE.get(key);
  if (!hit) return null;
  if (hit.exp < now()) { FUND_CACHE.delete(key); return null; }
  return hit.val;
}
function cacheSet(key, val, ttl = TTL_MS) {
  FUND_CACHE.set(key, { val, exp: now() + ttl });
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
    .slice(0, Math.min(limit, 200));
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
    .slice(0, Math.min(limit, 200));

  return { date: new Date().toISOString(), results: rows, source: "snapshot" };
}

// --- Routes ----------------------------------------------------------------

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, status: "ok", message: "Server is running", timestamp: new Date().toISOString() });
});

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
  console.log(`   WS   ws://0.0.0.0:${PORT}/ws`);
});
