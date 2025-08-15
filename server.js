// server.js
// Secure Polygon proxy for your scanners & apps

// --- Env (optional locally; DO passes vars at runtime) ---
try { require("dotenv").config(); } catch (_) {}

// --- Deps ---
const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws"); // optional WS passthrough

// --- App setup ---
const app = express();
app.use(cors());             // tighten later with allowlist if you want
app.use(express.json());

const PORT = process.env.PORT || 8080;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
if (!POLYGON_API_KEY) throw new Error("POLYGON_API_KEY is not set");

// Node 18+ has global fetch. If you’re on older Node, uncomment below:
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

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

function todayYMD() {
  return new Date().toISOString().slice(0, 10); // local date ok for per-day ranges
}

// ===== Helpers for robust /gainers =====
function ymdUTC(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    .toISOString().slice(0, 10); // YYYY-MM-DD
}
function prevUTCDate(d = new Date(), days = 1) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() - days);
  return x;
}
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

// Symbol snapshot (full polygon snapshot for ticker)
app.get("/symbol/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const data = await makePolygonRequest(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch symbol snapshot", message: String(e.message || e) });
  }
});

// ---- Robust /gainers computed from grouped aggregates ----
app.get("/gainers", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

    let day = ymdUTC(new Date());
    let grouped = await fetchGrouped(day);

    // Fallback to previous UTC day if empty (premarket/weekend/holiday)
    if (!grouped?.results?.length) {
      day = ymdUTC(prevUTCDate(new Date(), 1));
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
          date: day
        };
      })
      .sort((a, b) => b.pctChange - a.pctChange)
      .slice(0, limit);

    return res.json({ date: day, results: rows });
  } catch (e) {
    return res.status(500).json({ error: "Failed to compute gainers", message: String(e?.message || e) });
  }
});

// Optional alias to same logic
app.get("/market/top-gainers", async (req, res, next) => {
  req.url = "/gainers" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
  next();
}, app._router.stack.find(l => l.route && l.route.path === "/gainers").route.stack[0].handle);

// Aggregates (OHLCV)
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
      adjusted = true
    } = req.query;

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

// Latest price (minute-bar first, then snapshot fallback)
app.get("/price/:symbol", async (req, res) => {
  const { symbol } = req.params;
  try {
    const date = todayYMD();

    let price = null;

    // 1) most recent minute bar today
    try {
      const aggs = await makePolygonRequest(
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${date}/${date}`,
        { adjusted: true, sort: "desc", limit: 1 }
      );
      if (aggs?.results?.length) price = aggs.results[0].c; // close of latest minute
    } catch (_) {
      /* continue to snapshot */
    }

    // 2) snapshot last trade fallback
    if (price == null) {
      const snap = await makePolygonRequest(
        `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`
      );
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

// Previous close
app.get("/previous_close/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const data = await makePolygonRequest(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`, { adjusted: true });
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

  upstream.on("message", (msg) => {
    try { wsClient.send(msg.toString()); } catch {}
  });

  wsClient.on("message", (msg) => {
    try { if (upstream.readyState === WebSocket.OPEN) upstream.send(msg.toString()); } catch {}
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

// --- Start ---
server.listen(PORT, () => {
  console.log(`✅ polygon-proxy listening on ${PORT}`);
});
