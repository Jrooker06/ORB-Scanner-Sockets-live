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

// API Health endpoint for scanner compatibility
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, status: "ok", message: "Server is running", timestamp: new Date().toISOString() });
});

// ----- API endpoints for scanner compatibility -----
app.get("/api/gainers", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50", 10);
    let data;
    try {
      data = await computeSnapshotGainers(limit);   // intraday (live-ish)
    } catch (_) {
      data = await computeGainers(limit);           // fallback
    }
    
    // Convert to the format expected by the scanner
    const tickers = data.results.map(row => ({
      ticker: row.ticker,
      price: row.last || row.close,
      change: row.change,
      change_pct: row.pctChange,
      volume: row.volume
    }));
    
    res.json({ tickers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/float/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const overview = await getTickerOverview(symbol);
    res.json({ results: overview });
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

app.get("/api/news/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    res.json({ results: [] }); // Placeholder for news endpoint
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
    
    const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${dateStr}/${dateStr}`,
      { adjusted: true, sort: "desc", limit: parseInt(days_back) }
    );
    
    const prices = (data?.results || []).map(bar => bar.c).reverse();
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
      above_ema9: prices[prices.length - 1] > ema9
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
    
    const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${dateStr}/${dateStr}`,
      { adjusted: true, sort: "desc", limit: parseInt(days_back) }
    );
    
    const prices = (data?.results || []).map(bar => bar.c).reverse();
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
      above_ema21: prices[prices.length - 1] > ema21
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
    
    const { dateStr } = await findLastTradingDayNY(parseInt(days_back, 10) + 1);
    const data = await makePolygonRequest(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${dateStr}/${dateStr}`,
      { adjusted: true, sort: "desc", limit: parseInt(days_back) }
    );
    
    const prices = (data?.results || []).map(bar => bar.c).reverse();
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
      data_points: prices.length
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
