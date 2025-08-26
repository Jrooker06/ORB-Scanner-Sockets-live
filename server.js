/**
 * server.js — Polygon proxy (intraday snapshot gainers + REST + WS passthrough)
 *
 * Routes:
 *   GET  /health
 *   GET  /api/health                    -> Health check for scanner compatibility
 *   GET  /api/gainers                   -> Top gainers for scanner (formatted)
 *   GET  /api/float/:symbol             -> Float and sector data
 *   GET  /api/historical/:symbol        -> Historical price data
 *   GET  /api/news/:symbol              -> News data (placeholder)
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
// server.js
// A unified Polygon proxy that serves both WebSocket and REST your scanner expects.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
if (!POLYGON_API_KEY) {
  console.warn('⚠️  POLYGON_API_KEY not set. Set it in .env or environment.');
}

const app = express();
app.use(cors());
app.use(express.json());

// ---------- tiny cache (memory) ----------
const cache = new Map(); // key -> {ts, ttlMs, data}
const getCache = (key) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > hit.ttlMs) { cache.delete(key); return null; }
  return hit.data;
};
const setCache = (key, data, ttlMs = 5000) => cache.set(key, { ts: Date.now(), ttlMs, data });

// ---------- axios helper ----------
const ax = axios.create({
  baseURL: 'https://api.polygon.io',
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
  params: { apiKey: POLYGON_API_KEY }
});

// ---------- util: date helpers ----------
function ymd(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }

// ---------- WS proxy to Polygon stocks ----------
const server = app.listen(PORT, () => {
  console.log(`✅ Server listening on :${PORT}`);
});

const wss = new WebSocket.Server({ server, path: '/ws' });

// we maintain a single upstream Polygon socket and fan out
let polygonSocket = null;
let polygonConnected = false;
let upstreamClients = new Set();

function connectPolygonWS() {
  if (polygonSocket && (polygonSocket.readyState === WebSocket.OPEN || polygonSocket.readyState === WebSocket.CONNECTING)) return;

  polygonSocket = new WebSocket('wss://socket.polygon.io/stocks');

  polygonSocket.on('open', () => {
    polygonConnected = true;
    console.log('🔌 Connected to Polygon WS');
    // auth
    polygonSocket.send(JSON.stringify({ action: 'auth', params: POLYGON_API_KEY }));
  });

  polygonSocket.on('message', (msg) => {
    // fan out to all connected downstream clients
    for (const ws of upstreamClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  });

  polygonSocket.on('close', () => {
    polygonConnected = false;
    console.log('❌ Polygon WS closed. Reconnecting in 2s…');
    setTimeout(connectPolygonWS, 2000);
  });

  polygonSocket.on('error', (err) => {
    console.error('WS error:', err.message);
  });
}
connectPolygonWS();

wss.on('connection', (ws) => {
  upstreamClients.add(ws);
  console.log(`👥 client connected (total ${upstreamClients.size})`);

  ws.on('message', (raw) => {
    // forward all downstream messages (subs/unsubs) to Polygon
    if (polygonSocket && polygonSocket.readyState === WebSocket.OPEN) {
      polygonSocket.send(raw);
    }
  });

  ws.on('close', () => {
    upstreamClients.delete(ws);
    console.log(`👤 client disconnected (total ${upstreamClients.size})`);
  });
});

// ---------- REST: health ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, polygonWS: polygonConnected, time: new Date().toISOString() });
});

// ---------- REST: gainers ----------
app.get('/api/gainers', async (req, res) => {
  try {
    const key = 'gainers';
    const hit = getCache(key);
    if (hit) return res.json(hit);

    const { data } = await ax.get('/v2/snapshot/locale/us/markets/stocks/gainers');
    const tickers = (data.tickers || []).map(t => ({
      ticker: t.ticker,
      price: t.day?.c ?? 0,
      change: t.todaysChange ?? 0,
      change_pct: t.todaysChangePerc ?? 0,
      volume: t.day?.v ?? 0
    }));
    const out = { tickers };
    setCache(key, out, 3000);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'gainers failed', details: e.message });
  }
});

// ---------- REST: last trade / price ----------
app.get('/api/price/:symbol', async (req, res) => {
  try {
    const s = req.params.symbol.toUpperCase();
    const key = `price:${s}`;
    const hit = getCache(key);
    if (hit) return res.json(hit);

    // Prefer v3 last trade endpoint
    let price = null;
    try {
      const { data } = await ax.get(`/v3/trades/${s}/last`);
      price = data?.results?.p ?? null;
      if (price != null) {
        const out = { price, raw: data };
        setCache(key, out, 1500);
        return res.json(out);
      }
    } catch (_) {}

    // Fallback v2
    const { data } = await ax.get(`/v2/last/trade/${s}`);
    const out = { price: data?.results?.p ?? null, raw: data };
    setCache(key, out, 1500);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'price failed', details: e.message });
  }
});

// ---------- REST: previous close ----------
app.get('/previous_close/:symbol', async (req, res) => {
  try {
    const s = req.params.symbol.toUpperCase();
    const { data } = await ax.get(`/v2/aggs/ticker/${s}/prev`, { params: { adjusted: true } });
    const prev = data?.results?.[0]?.c ?? null;
    res.json({ previousClose: prev, raw: data });
  } catch (e) {
    res.status(500).json({ error: 'previous_close failed', details: e.message });
  }
});

// ---------- helper: get intraday aggregates ----------
async function getMinuteAggs(symbol, startISO, endISO, interval = 1) {
  const s = symbol.toUpperCase();
  // Polygon expects YYYY-MM-DD for day ranges (it will assume midnight to midnight local)
  const from = startISO.slice(0, 10);
  const to = endISO.slice(0, 10);
  const { data } = await ax.get(`/v2/aggs/ticker/${s}/range/${interval}/minute/${from}/${to}`, {
    params: { adjusted: true, sort: 'asc', limit: 50000 }
  });
  const results = (data.results || []).map(r => ({
    t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v
  }));
  return results;
}

// ---------- REST: minute OHLCV (ORB) ----------
app.get('/api/historical/:symbol', async (req, res) => {
  try {
    const s = req.params.symbol.toUpperCase();
    const interval = Math.max(1, parseInt(req.query.interval || '1', 10));
    const daysBack = Math.max(1, parseInt(req.query.days_back || '1', 10));
    const end = new Date();
    const start = daysAgo(daysBack);

    const key = `hist:${s}:${interval}:${ymd(start)}:${ymd(end)}`;
    const hit = getCache(key);
    if (hit) return res.json({ results: hit });

    const results = await getMinuteAggs(s, start.toISOString(), end.toISOString(), interval);
    setCache(key, results, 4000);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: 'historical failed', details: e.message });
  }
});

// ---------- REST: float / sector (company info) ----------
app.get('/api/float/:symbol', async (req, res) => {
  try {
    const s = req.params.symbol.toUpperCase();
    const { data } = await ax.get(`/v3/reference/tickers/${s}`);
    const r = data?.results || {};
    res.json({
      results: {
        marketCap: r.market_cap ?? null,
        weightedSharesOut: r.weighted_shares_outstanding ?? null,
        shareClassSharesOut: r.share_class_shares_outstanding ?? null,
        sic_description: r.sic_description ?? null,
        sector: r.sic_description ?? null
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'float failed', details: e.message });
  }
});

// ---------- math helpers for indicators ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  let emaPrev = values[0];
  const out = [emaPrev];
  for (let i = 1; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
    out.push(emaPrev);
  }
  return out;
}
function vwapFromBars(bars) {
  let cumPV = 0, cumV = 0;
  const out = [];
  for (const b of bars) {
    const typical = (b.h + b.l + b.c) / 3;
    cumPV += typical * b.v;
    cumV += b.v;
    out.push(cumV ? (cumPV / cumV) : null);
  }
  return out;
}
function rsi(values, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  const out = [];
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = Math.max(diff, 0), loss = Math.max(-diff, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out.push(100 - 100 / (1 + rs));
  }
  return out[out.length - 1] ?? null;
}
function macd(values, fast = 12, slow = 26, signal = 9) {
  if (values.length < slow + signal + 5) return { macd: null, signal: null, hist: null };
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => (i < slow - 1 ? null : (emaFast[i] - emaSlow[i])));
  const macdVals = macdLine.filter(v => v != null);
  const signalLine = ema(macdVals, signal);
  const lastMacd = macdVals[macdVals.length - 1] ?? null;
  const lastSignal = signalLine[signalLine.length - 1] ?? null;
  const lastHist = (lastMacd != null && lastSignal != null) ? (lastMacd - lastSignal) : null;
  return { macd: lastMacd, signal: lastSignal, hist: lastHist };
}

// ---------- indicators via bars ----------
async function getCloseSeries(symbol, periodsNeeded = 120) {
  const end = new Date();
  const start = daysAgo(2); // 2 days to be safe
  const bars = await getMinuteAggs(symbol, start.toISOString(), end.toISOString(), 1);
  const closes = bars.map(b => b.c);
  return { bars, closes: closes.slice(-periodsNeeded) };
}

app.get('/api/ema9/:symbol', async (req, res) => {
  try {
    const s = req.params.symbol.toUpperCase();
    const { bars } = await getCloseSeries(s, 60);
    const closes = bars.map(b => b.c);
    if (closes.length < 9) return res.json({ ema9: null });
    const out = ema(closes, 9).pop();
    res.json({ ema9: out });
  } catch (e) {
    res.status(500).json({ error: 'ema9 failed', details: e.message });
  }
});

app.get('/api/ema21/:symbol', async (req, res) => {
  try {
    const s = req.params.symbol.toUpperCase();
    const { bars } = await getCloseSeries(s, 100);
    const closes = bars.map(b => b.c);
    if (closes.length < 21) return res.json({ ema21: null });
    const out = ema(closes, 21).pop();
    res.json({ ema21: out });
  } catch (e) {
    res.status(500).json({ error: 'ema21 failed', details: e.message });
  }
});

app.get('/api/vwap/:symbol', async (req, res) => {
  try {
    const s = req.params.symbol.toUpperCase();
    const end = new Date();
    const start = daysAgo(1);
    const bars = await getMinuteAggs(s, start.toISOString(), end.toISOString(), 1);
    const arr = vwapFromBars(bars);
    res.json({ vwap: arr[arr.length - 1] ?? null });
  } catch (e) {
    res.status(500).json({ error: 'vwap failed', details: e.message });
  }
});

app.get('/api/rsi/:symbol', async (req, res) => {
  try {
    const s = req.params.symbol.toUpperCase();
    const period = Math.max(2, parseInt(req.query.period || '14', 10));
    const { bars } = await getCloseSeries(s, 14 + 60);
    const closes = bars.map(b => b.c);
    const val = rsi(closes, period);
    res.json({ rsi: val });
  } catch (e) {
    res.status(500).json({ error: 'rsi failed', details: e.message });
  }
});

app.get('/api/macd/:symbol', async (req, res) => {
  try {
    const s = req.params.symbol.toUpperCase();
    const { bars } = await getCloseSeries(s, 26 + 50);
    const closes = bars.map(b => b.c);
    const m = macd(closes);
    res.json(m);
  } catch (e) {
    res.status(500).json({ error: 'macd failed', details: e.message });
  }
});

// ---------- simple support/resistance (recent pivots) ----------
app.get('/api/support-resistance/:symbol', async (req, res) => {
  try {
    const s = req.params.symbol.toUpperCase();
    const end = new Date();
    const start = daysAgo(3);
    const bars = await getMinuteAggs(s, start.toISOString(), end.toISOString(), 5); // 5-min pivots
    const highs = bars.map(b => b.h);
    const lows = bars.map(b => b.l);

    const pivH = [], pivL = [];
    for (let i = 2; i < highs.length - 2; i++) {
      if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) pivH.push(highs[i]);
      if (lows[i]  < lows[i-1]  && lows[i]  < lows[i-2]  && lows[i]  < lows[i+1]  && lows[i]  < lows[i+2])  pivL.push(lows[i]);
    }
    // return a few nearest levels
    const uniq = (arr) => [...new Set(arr.map(x => x.toFixed(2)))].map(Number);
    res.json({ resistance: uniq(pivH).slice(-5), support: uniq(pivL).slice(-5) });
  } catch (e) {
    res.status(500).json({ error: 'support-resistance failed', details: e.message });
  }
});

// ---------- market status ----------
app.get('/api/market/status', async (req, res) => {
  try {
    const { data } = await ax.get('/v1/marketstatus/now');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'market status failed', details: e.message });
  }
});
