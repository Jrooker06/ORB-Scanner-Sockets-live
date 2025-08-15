const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Enable CORS
app.use(cors());

// Your Polygon API key (keep this secure!)
const POLYGON_API_KEY = "la79AawZg0NOZJ3ldtFztVagVQ4hHBjM";

// Health endpoint
app.get('/health', (req, res) => {
    res.json({ 
        ok: true,
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

// Gainers endpoint
app.get('/gainers', async (req, res) => {
    try {
        const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${POLYGON_API_KEY}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.results && data.results.length > 0) {
            const gainers = data.results.map(stock => ({
                ticker: stock.ticker,  // This is what the Python scanner expects
                symbol: stock.ticker,  // Keep for backward compatibility
                price: stock.lastTrade?.p || null,
                change: stock.lastTrade?.p ? stock.lastTrade.p - (stock.prevDay?.c || 0) : null,
                changePercent: stock.lastTrade?.p && stock.prevDay?.c ? 
                    ((stock.lastTrade.p - stock.prevDay.c) / stock.prevDay.c * 100).toFixed(2) : null,
                volume: stock.lastTrade?.s || null,
                previousClose: stock.prevDay?.c || null
            }));
            
            res.json({ results: gainers });
        } else {
            // Fallback: provide popular tickers when no gainers data is available
            console.log('No gainers data from Polygon API, providing fallback tickers');
            const fallbackTickers = [
                { ticker: 'AAPL', symbol: 'AAPL', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'MSFT', symbol: 'MSFT', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'GOOGL', symbol: 'GOOGL', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'AMZN', symbol: 'AMZN', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'TSLA', symbol: 'TSLA', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'META', symbol: 'META', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'NVDA', symbol: 'NVDA', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'SPY', symbol: 'SPY', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'QQQ', symbol: 'QQQ', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'IWM', symbol: 'IWM', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'VTI', symbol: 'VTI', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'AMD', symbol: 'AMD', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'INTC', symbol: 'INTC', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'CRM', symbol: 'CRM', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'ORCL', symbol: 'ORCL', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'ADBE', symbol: 'ADBE', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'PYPL', symbol: 'PYPL', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'UBER', symbol: 'UBER', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'LYFT', symbol: 'LYFT', price: null, change: null, changePercent: null, volume: null, previousClose: null },
                { ticker: 'NFLX', symbol: 'NFLX', price: null, change: null, changePercent: null, volume: null, previousClose: null }
            ];
            
            res.json({ results: fallbackTickers });
        }
    } catch (error) {
        console.error('Gainers error:', error);
        
        // Even on error, provide fallback tickers so the scanner can work
        console.log('Providing fallback tickers due to API error');
        const fallbackTickers = [
            { ticker: 'AAPL', symbol: 'AAPL', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'MSFT', symbol: 'MSFT', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'GOOGL', symbol: 'GOOGL', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'AMZN', symbol: 'AMZN', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'TSLA', symbol: 'TSLA', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'META', symbol: 'META', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'NVDA', symbol: 'NVDA', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'SPY', symbol: 'SPY', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'QQQ', symbol: 'QQQ', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'IWM', symbol: 'IWM', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'VTI', symbol: 'VTI', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'AMD', symbol: 'AMD', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'INTC', symbol: 'INTC', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'CRM', symbol: 'CRM', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'ORCL', symbol: 'ORCL', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'ADBE', symbol: 'ADBE', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'PYPL', symbol: 'PYPL', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'UBER', symbol: 'UBER', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'LYFT', symbol: 'LYFT', price: null, change: null, changePercent: null, volume: null, previousClose: null },
            { ticker: 'NFLX', symbol: 'NFLX', price: null, change: null, changePercent: null, volume: null, previousClose: null }
        ];
        
        res.json({ results: fallbackTickers });
    }
});

// Price endpoint
app.get('/price/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${POLYGON_API_KEY}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.results && data.results.lastTrade) {
            res.json({
                symbol: symbol.toUpperCase(),
                price: data.results.lastTrade.p
            });
        } else {
            res.json({
                symbol: symbol.toUpperCase(),
                price: null
            });
        }
    } catch (error) {
        console.error('Price error:', error);
        res.status(500).json({
            error: 'Failed to fetch price data',
            message: error.message
        });
    }
});

// Previous close endpoint
app.get('/previous_close/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${POLYGON_API_KEY}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.results && data.results.prevDay) {
            res.json({
                symbol: symbol.toUpperCase(),
                previous_close: data.results.prevDay.c
            });
        } else {
            res.json({
                symbol: symbol.toUpperCase(),
                previous_close: null
            });
        }
    } catch (error) {
        console.error('Previous close error:', error);
        res.status(500).json({
            error: 'Failed to fetch previous close data',
            message: error.message
        });
    }
});

// OHLCV endpoint
app.get('/ohlcv/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const { multiplier = 1, timespan = 'minute' } = req.query;
        
        // Calculate date range (last 24 hours for minute data)
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 1);
        
        // Format dates for Polygon API
        const formatDate = (date) => date.toISOString().split('T')[0];
        
        const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${formatDate(startDate)}/${formatDate(endDate)}?adjusted=true&sort=desc&limit=500&apiKey=${POLYGON_API_KEY}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.results) {
            const ohlcv = data.results.map(bar => ({
                o: bar.o, // Open
                h: bar.h, // High
                l: bar.l, // Low
                c: bar.c, // Close
                v: bar.v, // Volume
                t: bar.t, // Timestamp
                n: bar.n  // Number of transactions
            }));
            
            res.json({ results: ohlcv });
        } else {
            res.json({ results: [] });
        }
    } catch (error) {
        console.error('OHLCV error:', error);
        res.status(500).json({
            error: 'Failed to fetch OHLCV data',
            message: error.message
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
    console.log(`Server listening on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`Gainers: http://localhost:${PORT}/gainers`);
    console.log(`Price: http://localhost:${PORT}/price/:symbol`);
    console.log(`Previous Close: http://localhost:${PORT}/previous_close/:symbol`);
    console.log(`OHLCV: http://localhost:${PORT}/ohlcv/:symbol`);
    console.log(`Historical data: http://localhost:${PORT}/historical/:ticker`);
}); 
