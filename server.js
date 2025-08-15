// server.js
// Minimal Polygon proxy API for your desktop scanner
// Exposes the routes your client already calls: /gainers, /ohlcv/:symbol, /price/:symbol, /previous_close/:symbol
// Also keeps some utility routes like /symbol/:symbol and /market/top-gainers

require('dotenv').config();
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

// ----- Config -----
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
if (!POLYGON_API_KEY) {
  // Fail fast if not set (prevents confusing 500s later)
  throw new Error("POLYGON_API_KEY is not set");
}
const PORT = process.env.PORT || 8080;

// ----- Helpers -----
async function makePolygonRequest(path, params = {}) {
  const base = "https://api.polygon.io";
  // IMPORTANT: spread "params" correctly; do NOT use ".params"
  const queryString = new URLSearchParams({ ...params, apiKey: POLYGON_API_KEY }).toString();
  const url = `${base}${path}?${queryString}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Polygon error ${resp.status}: ${text || resp.statusText}`);
  }
  return resp.json();
}

// ----- Health -----
app.get("/health", (_req, res) => res.json({ ok: true, service: "polygon-proxy", time: new Date().toISOString() }));

// ----- Existing utility endpoints (nice to keep) -----

// Snapshot for a single symbol (used internally by /price & /previous_close)
app.get("/symbol/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const data = await makePolygonRequest(`/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch symbol snapshot", message: e.message });
  }
});

// Top gainers (Polygon snapshot)
app.get("/market/top-gainers", async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const data = await makePolygonRequest("/v2/snapshot/locale/us/markets/stocks/gainers");
    const results = Array.isArray(data?.results) ? data.results.slice(0, Number(limit)) : [];
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch top gainers", message: e.message });
  }
});

// Minute bars / historical aggregates
// Example: /historical/AAPL?interval=1&days_back=1
app.get("/historical/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { interval = 1, days_back = 1 } = req.query;

    // Default to today's date when not provided
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const start = today;
    const end = today;

    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${symbol}/range/${interval}/minute/${start}/${end}`,
      { adjusted: true, sort: "asc", limit: 500 }
    );

    res.json({ results: data?.results ?? [] });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch historical data", message: e.message });
  }
});

// ----- NEW: Endpoints that match your Python client's expectations -----

// 1) Alias for top gainers to exactly match your client
app.get("/gainers", async (_req, res) => {
  try {
    const data = await makePolygonRequest("/v2/snapshot/locale/us/markets/stocks/gainers");
    const results = (data?.results ?? []).map(r => ({ ticker: r.ticker }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch gainers", message: e.message });
  }
});

// 2) Minute OHLCV for a symbol (defaults to today's minute bars)
app.get("/ohlcv/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { multiplier = 1, timespan = "minute", from, to } = req.query;

    // If from/to not supplied, default to today
    const end = to || new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
    const start = from || end;

    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${start}/${end}`,
      { adjusted: true, sort: "asc", limit: 500 }
    );

    res.json({ results: data?.results ?? [] });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch OHLCV", message: e.message });
  }
});

// 3) Latest price
app.get("/price/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const snap = await makePolygonRequest(`/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`);
    const price = snap?.results?.last_quote?.p ?? null;
    res.json({ symbol, price });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch price", message: e.message });
  }
});

// 4) Previous close
app.get("/previous_close/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const snap = await makePolygonRequest(`/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`);
    const previous_close = snap?.results?.prevDay?.c ?? null;
    res.json({ symbol, previous_close });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch previous close", message: e.message });
  }
});

// ----- WebSocket proxy (optional for your app right now) -----
// Proxies /ws to Polygon's stocks feed and forwards auth using your server-side key.
// Client connects to: wss://<your-app-domain>/ws  and then sends subscriptions payload.
const server = app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/ws") {
    wss.handleUpgrade(request, socket, head, (wsClient) => {
      wss.emit("connection", wsClient, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (wsClient) => {
  // Connect to Polygon stream
  const polygonWS = new WebSocket("wss://socket.polygon.io/stocks");

  polygonWS.on("open", () => {
    // Authenticate upstream with your key
    polygonWS.send(JSON.stringify({ action: "auth", params: POLYGON_API_KEY }));
  });

  // Forward upstream messages to the client
  polygonWS.on("message", (msg) => {
    try {
      wsClient.send(msg.toString());
    } catch (_) {}
  });

  // If client sends subscriptions, relay them upstream
  wsClient.on("message", (msg) => {
    try {
      const str = msg.toString();
      // Pass through client subscription messages (e.g., {action:"subscribe", params:"T.AAPL"})
      polygonWS.readyState === WebSocket.OPEN && polygonWS.send(str);
    } catch (_) {}
  });

  // Clean up
  const cleanup = () => {
    try { wsClient.close(); } catch (_) {}
    try { polygonWS.close(); } catch (_) {}
  };

  wsClient.on("close", cleanup);
  wsClient.on("error", cleanup);
  polygonWS.on("close", cleanup);
  polygonWS.on("error", cleanup);
});