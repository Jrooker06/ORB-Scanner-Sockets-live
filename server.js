const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// Your Polygon API key (keep this secure!)
const POLYGON_API_KEY = "la79AawZg0NOZJ3ldtFztVagVQ4hHBjM";

// In-memory cache for performance
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper function to check cache
function getFromCache(key) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    return null;
}

// Helper function to set cache
function setCache(key, data) {
    cache.set(key, {
        data,
        timestamp: Date.now()
    });
}

// Helper function to make Polygon API requests
async function makePolygonRequest(endpoint, params = {}) {
    try {
        const queryString = new URLSearchParams({
            ...params,
            apiKey: POLYGON_API_KEY
        }).toString();
        
        const url = `https://api.polygon.io${endpoint}?${queryString}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Polygon API error: ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error(`Polygon API request failed: ${error.message}`);
        throw error;
    }
}

// Health endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'Polygon WebSocket Proxy Server',
        endpoints: {
            health: '/health',
            websocket: '/ws',
            gainers: '/gainers',
            price: '/price/:symbol',
            previous_close: '/previous_close/:symbol',
            ohlcv: '/ohlcv/:symbol',
            historical: '/historical/:ticker'
        }
    });
});

// Gainers endpoint (required by checklist)
app.get('/gainers', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const cacheKey = `gainers_${limit}`;
        
        // Check cache first
        const cached = getFromCache(cacheKey);
        if (cached) {
            return res.json({
                results: cached,
                cached: true
            });
        }
        
        // Get top gainers from Polygon
        const data = await makePolygonRequest('/v2/snapshot/locale/us/markets/stocks/gainers', {
            limit: limit
        });
        
        if (data.results) {
            const gainers = data.results.map(item => ({
                ticker: item.ticker,
                price: item.last_quote?.p || 0,
                change: item.last_quote?.p - item.prevDay?.c || 0,
                change_percent: ((item.last_quote?.p - item.prevDay?.c) / item.prevDay?.c * 100) || 0,
                volume: item.last_trade?.s || 0,
                market_cap: item.market?.market_cap || 0
            }));
            
            setCache(cacheKey, gainers);
            
            res.json({
                results: gainers
            });
        } else {
            res.json({
                results: []
            });
        }
        
    } catch (error) {
        console.error('Gainers error:', error);
        res.status(500).json({
            error: 'Failed to fetch gainers',
            message: error.message
        });
    }
});

// Price endpoint (required by checklist)
app.get('/price/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const cacheKey = `price_${symbol}`;
        
        // Check cache first
        const cached = getFromCache(cacheKey);
        if (cached) {
            return res.json({
                symbol: symbol,
                price: cached,
                cached: true
            });
        }
        
        // Get current price from Polygon
        const data = await makePolygonRequest(`/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`);
        
        if (data.results && data.results.last_quote) {
            const price = data.results.last_quote.p;
            
            setCache(cacheKey, price);
            
            res.json({
                symbol: symbol,
                price: price
            });
        } else {
            res.json({
                symbol: symbol,
                price: null
            });
        }
        
    } catch (error) {
        console.error(`Price error for ${req.params.symbol}:`, error);
        res.json({
            symbol: req.params.symbol,
            price: null
        });
    }
});

// Previous close endpoint (required by checklist)
app.get('/previous_close/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const cacheKey = `prev_close_${symbol}`;
        
        // Check cache first
        const cached = getFromCache(cacheKey);
        if (cached) {
            return res.json({
                symbol: symbol,
                previous_close: cached,
                cached: true
            });
        }
        
        // Get previous close from Polygon
        const data = await makePolygonRequest(`/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`);
        
        if (data.results && data.results.prevDay) {
            const prevClose = data.results.prevDay.c;
            
            setCache(cacheKey, prevClose);
            
            res.json({
                symbol: symbol,
                previous_close: prevClose
            });
        } else {
            res.json({
                symbol: symbol,
                previous_close: null
            });
        }
        
    } catch (error) {
        console.error(`Previous close error for ${req.params.symbol}:`, error);
        res.json({
            symbol: req.params.symbol,
            previous_close: null
        });
    }
});

// OHLCV endpoint (required by checklist)
app.get('/ohlcv/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const { multiplier = 1, timespan = 'minute' } = req.query;
        const cacheKey = `ohlcv_${symbol}_${multiplier}_${timespan}`;
        
        // Check cache first
        const cached = getFromCache(cacheKey);
        if (cached) {
            return res.json({
                results: cached,
                cached: true
            });
        }
        
        // Get today's data for OHLCV
        const today = new Date();
        const formattedDate = today.toISOString().split('T')[0];
        
        const data = await makePolygonRequest(`/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${formattedDate}/${formattedDate}`, {
            adjusted: true,
            sort: 'desc',
            limit: 1000
        });
        
        if (data.results && data.results.length > 0) {
            const ohlcv = data.results.map(bar => ({
                t: bar.t, // timestamp
                o: bar.o, // open
                h: bar.h, // high
                l: bar.l, // low
                c: bar.c, // close
                v: bar.v, // volume
                vw: bar.vw, // volume weighted average price
                n: bar.n // number of transactions
            }));
            
            setCache(cacheKey, ohlcv);
            
            res.json({
                results: ohlcv
            });
        } else {
            res.json({
                results: []
            });
        }
        
    } catch (error) {
        console.error(`OHLCV error for ${req.params.symbol}:`, error);
        res.json({
            results: []
        });
    }
});

// Historical data endpoint for testing
app.get('/historical/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        const days = parseInt(req.query.days) || 1;
        const minVolume = parseInt(req.query.min_volume) || 1000;
        
        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        
        // Format dates for Polygon API
        const formatDate = (date) => date.toISOString().split('T')[0];
        
        // Get historical data from Polygon
        const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${formatDate(startDate)}/${formatDate(endDate)}?adjusted=true&sort=desc&limit=100&apiKey=${POLYGON_API_KEY}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.results) {
            // Filter by volume and format data
            const trades = data.results
                .filter(trade => trade.v >= minVolume)
                .map(trade => ({
                    price: trade.c, // Close price
                    volume: trade.v,
                    timestamp: new Date(trade.t).toISOString(),
                    open: trade.o,
                    high: trade.h,
                    low: trade.l
                }))
                .slice(0, 20); // Limit to 20 trades
            
            res.json({
                ticker,
                trades,
                count: trades.length,
                dateRange: {
                    start: formatDate(startDate),
                    end: formatDate(endDate)
                }
            });
        } else {
            res.json({
                ticker,
                trades: [],
                count: 0,
                message: 'No data available'
            });
        }
        
    } catch (error) {
        console.error('Historical data error:', error);
        res.status(500).json({
            error: 'Failed to fetch historical data',
            message: error.message
        });
    }
});

// WebSocket endpoint - handle upgrade manually
app.get('/ws', (req, res) => {
    res.status(426).json({
        error: 'WebSocket upgrade required',
        message: 'This endpoint requires WebSocket connection'
    });
});

// WebSocket server
const wss = new WebSocket.Server({ 
    server,
    path: '/ws'
});

// Store Polygon WebSocket connection
let polygonWs = null;

wss.on('connection', (ws, req) => {
    console.log('Client connected to WebSocket');
    
    // Connect to Polygon WebSocket if not already connected
    if (!polygonWs) {
        console.log('Connecting to Polygon WebSocket...');
        polygonWs = new WebSocket('wss://socket.polygon.io/stocks');
        
        polygonWs.on('open', () => {
            console.log('Connected to Polygon WebSocket');
            // Authenticate with Polygon
            polygonWs.send(JSON.stringify({
                action: 'auth',
                params: POLYGON_API_KEY
            }));
        });
        
        polygonWs.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                // Forward Polygon data to all connected clients
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(data.toString());
                    }
                });
            } catch (error) {
                console.error('Error parsing Polygon message:', error);
            }
        });
        
        polygonWs.on('error', (error) => {
            console.error('Polygon WebSocket error:', error);
        });
        
        polygonWs.on('close', () => {
            console.log('Polygon WebSocket disconnected');
            polygonWs = null;
        });
    }
    
    // Handle messages from client
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // Forward subscription requests to Polygon
            if (data.action === 'subscribe' && polygonWs && polygonWs.readyState === WebSocket.OPEN) {
                console.log('Forwarding subscription:', data.params);
                polygonWs.send(JSON.stringify(data));
            }
            
            // Forward authentication requests to Polygon
            if (data.action === 'auth' && polygonWs && polygonWs.readyState === WebSocket.OPEN) {
                console.log('Forwarding auth request');
                polygonWs.send(JSON.stringify({
                    action: 'auth',
                    params: POLYGON_API_KEY
                }));
            }
            
        } catch (error) {
            console.error('Error parsing client message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('Client disconnected');
    });
    
    ws.on('error', (error) => {
        console.error('Client WebSocket error:', error);
    });
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
    if (request.url === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`Historical data: http://localhost:${PORT}/historical/:ticker`);
}); 
