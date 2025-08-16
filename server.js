// server.js — Polygon proxy (NY market–aware)
// Routes: /health, /gainers, /market/top-gainers, /symbol/:symbol,
//         /ohlcv/:symbol, /price/:symbol, /previous_close/:symbol
// Optional WS passthrough at /ws

// --- Env (dotenv optional for local dev; DO injects envs) ---
try { require("dotenv").config(); } catch (_) {}

// --- Deps ---
const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

// --- App setup ---
const app = express();
app.use(cors());            // tighten later with allowlist
app.use(express.json());

const PORT = process.env.PORT || 8080;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
if (!POLYGON_API_KEY) throw new Error("POLYGON_API_KEY is not set");

// Node 18+ has global fetch available

// --- Helpers ---
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

// NY-market calendar helpers (America/New_York)
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
function todayYMD() { return ymdNY(new Date()); }
function prevDayYMD() { return ymdNY(addDays(new Date(), -1)); }

async function fetchGrouped(dateStr) {
  return await makePolygonRequest(`/v2/aggs/grouped/locale/us/market/stocks/${dateStr}`, {
    adjusted: true,
    limit: 50000,
  });
}

// --- Routes ---

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, status: "ok", message: "Server is running", timestamp: new Date().toISOString() });
});

// Full symbol snapshot
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

// Compute gainers from grouped aggregates (works pre/post/closed with fallback)
async function computeGainers(limit = 50) {
  let day = todayYMD();
  let grouped = await fetchGrouped(day);
  if (!grouped?.results?.length) {
    day = prevDayYMD();
    grouped = await fetchGrouped(day);
  }
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
        date: day,
      };
    })
    .sort((a, b) => b.pctChange - a.pctChange)
    .slice(0, Math.min(limit, 200));
  return { date: day, results: rows };
}

app.get("/gainers", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50", 10);
    const data = await computeGainers(limit);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Failed to compute gainers", message: String(e.message || e) });
  }
});

// alias
app.get("/market/top-gainers", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50", 10);
    const data = await computeGainers(limit);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Failed to compute gainers", message: String(e.message || e) });
  }
});

// OHLCV with previous-day fallback when client didn't pin dates
app.get("/ohlcv/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const {
      multiplier = 1,
      timespan = "minute",
      from,
      to,
      limit = 500,
      sort = "asc",
      adjusted = true,
    } = req.query;

    let end = to || todayYMD();
    let start = from || end;

    let data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${start}/${end}`,
      { adjusted, sort, limit }
    );

    if ((!data?.results?.length) && !from && !to) {
      const prev = prevDayYMD();
      data = await makePolygonRequest(
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${prev}/${prev}`,
        { adjusted, sort, limit }
      );
    }

    res.json({ results: Array.isArray(data?.results) ? data.results : [] });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch OHLCV", message: String(e.message || e) });
  }
});

// Latest price: try latest minute bar (today NY), then previous day, then snapshot last trade
app.get("/price/:symbol", async (req, res) => {
  const { symbol } = req.params;
  try {
    let price = null;

    // 1) latest minute bar for today (NY)
    const day = todayYMD();
    try {
      const aggs = await makePolygonRequest(
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${day}/${day}`,
        { adjusted: true, sort: "desc", limit: 1 }
      );
      if (aggs?.results?.length) price = aggs.results[0].c;
    } catch (_) {}

    // 2) previous day minute bar if still null
    if (price == null) {
      const prev = prevDayYMD();
      try {
        const aggsPrev = await makePolygonRequest(
          `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${prev}/${prev}`,
          { adjusted: true, sort: "desc", limit: 1 }
        );
        if (aggsPrev?.results?.length) price = aggsPrev.results[0].c;
      } catch (_) {}
    }

    // 3) snapshot last trade fallback
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

// --- WebSocket passthrough (optional) ---
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

// --- Start ---
server.listen(PORT, () => {
  console.log(`✅ polygon-proxy listening on ${PORT}`);
});
