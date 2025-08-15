// server.js
// Secure Polygon proxy for your desktop scanner
// Routes: /health, /gainers, /market/top-gainers, /symbol/:symbol,
//         /ohlcv/:symbol, /price/:symbol (robust), /previous_close/:symbol
// WS passthrough at: /ws

require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

// ---------- App & Config ----------
const app = express();
app.use(cors());            // tighten later: app.use(cors({ origin: ["http://localhost:3000"], credentials:false }))
app.use(express.json());

const PORT = process.env.PORT || 8080;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
if (!POLYGON_API_KEY) throw new Error("POLYGON_API_KEY is not set");

// Node 18+ has global fetch; if older, uncomment below
// const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// ---------- Helpers ----------
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

function todayYMD() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---------- Health ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, status: "ok", message: "Server is running", timestamp: new Date().toISOString() });
});

// ---------- Snapshots / Market ----------
app.get("/symbol/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const data = await makePolygonRequest(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch symbol snapshot", message: String(e.message || e) });
  }
});

app.get("/market/top-gainers", async (_req, res) => {
  try {
    const data = await makePolygonRequest("/v2/snapshot/locale/us/markets/stocks/gainers");
    res.json({ results: Array.isArray(data?.results) ? data.results : [] });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch top gainers", message: String(e.message || e) });
  }
});

// Alias used by your client
app.get("/gainers", async (_req, res) => {
  try {
    const data = await makePolygonRequest("/v2/snapshot/locale/us/markets/stocks/gainers");
    const tickers = (data?.results || []).map(r => ({ ticker: r?.ticker || r?.T || "" })).filter(x => x);
    res.json({ results: tickers });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch gainers", message: String(e.message || e) });
  }
});

// ---------- Aggregates (OHLCV) ----------
app.get("/ohlcv/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { multiplier = 1, timespan = "minute", from, to, limit = 500, sort = "asc", adjusted = true } = req.query;

    const end = to || todayYMD();
    const start = from || end;

    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${start}/${end}`,
      { adjusted, sort, limit }
    );

    res.json({ results: Array.isArray(data?.results) ? data.results : [] });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch OHLCV", message: String(e.message || e) });
  }
});

// ---------- Latest Price (robust) ----------
app.get("/price/:symbol", async (req, res) => {
  const { symbol } = req.params;
  try {
    const date = todayYMD();

    // 1) Try the latest minute bar for today (works during RTH without special last-trade entitlements)
    let price = null;
    try {
      const aggs = await makePolygonRequest(
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${date}/${date}`,
        { adjusted: true, sort: "desc", limit: 1 }
      );
      if (aggs?.results?.length) price = aggs.results[0].c; // minute close
    } catch (_) {
      // keep going to fallback
    }

    // 2) Fallback to snapshot last trade
    if (price == null) {
      const snap = await makePolygonRequest(
        `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`
      );
      // polygon snapshot shapes vary; check multiple places
      price = snap?.ticker?.lastTrade?.p
           ?? snap?.results?.lastTrade?.p
           ?? snap?.lastTrade?.p
           ?? null;
    }

    return res.json({ symbol, price });
  } catch (e) {
    return res.status(500).json({ symbol, price: null, error: String(e.message || e) });
  }
});

// ---------- Previous Close ----------
app.get("/previous_close/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    // Prefer the dedicated "prev close" endpoint
    const data = await makePolygonRequest(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`, { adjusted: true });
    const prev = Array.isArray(data?.results) ? data.results[0] : null;
    res.json({ symbol, previousClose: prev?.c ?? null, raw: prev || null });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch previous close", message: String(e.message || e) });
  }
});

// ---------- WebSocket passthrough (optional) ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Client connects to ws(s)://<host>/ws and we forward to Polygon sockets
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
    // auth upstream
    upstream.send(JSON.stringify({ action: "auth", params: POLYGON_API_KEY }));
  });

  upstream.on("message", (msg) => {
    try { wsClient.send(msg.toString()); } catch { /* ignore */ }
  });

  wsClient.on("message", (msg) => {
    try {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(msg.toString());
    } catch { /* ignore */ }
  });

  const cleanup = () => {
    try { wsClient.close(); } catch {}
    try { upstream.close(); } catch {}
  };
  wsClient.on("close", cleanup);
  wsClient.on("error", cleanup);
  upstream.on("close", cleanup);
  upstream.on("error", cleanup);
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`✅ polygon-proxy listening on ${PORT}`);
});
