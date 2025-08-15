# ORB Scanner Polygon Proxy Server

A secure, high-performance proxy server for Polygon.io market data, designed specifically for the ORB Scanner desktop application.

## 🚀 Features

- **REST API Endpoints** for market data, symbols, and technical analysis
- **WebSocket Support** for real-time data streaming
- **Caching System** for improved performance
- **CORS Enabled** for web application integration
- **Environment-based Configuration** for different deployment environments

## 📋 API Endpoints

### Market Data
- `GET /health` - Server health check
- `GET /gainers` - Top gainers from Polygon
- `GET /market/top-gainers` - Market top gainers with limit support

### Symbol Data
- `GET /symbol/:symbol` - Symbol snapshot data
- `GET /price/:symbol` - Current price for a symbol
- `GET /previous_close/:symbol` - Previous close price

### Historical Data
- `GET /ohlcv/:symbol` - OHLCV data for a symbol
- `GET /historical/:symbol` - Historical aggregates with interval support

### WebSocket
- `WS /ws` - Real-time data streaming proxy to Polygon

## 🛠️ Setup

### Prerequisites
- Node.js 24.x or higher
- npm 11.x or higher
- Polygon.io API key

### Installation
```bash
# Clone the repository
git clone <your-repo-url>
cd <repo-name>

# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Edit .env and add your POLYGON_API_KEY
```

### Environment Variables
Create a `.env` file with:
```env
POLYGON_API_KEY=your_polygon_api_key_here
PORT=8080
```

### Running Locally
```bash
# Development mode
npm run dev

# Production mode
npm start
```

## 🚀 Deployment

### DigitalOcean App Platform

1. **Connect GitHub Repository**
   - Link your GitHub repo to DigitalOcean App Platform
   - Select the main branch

2. **Configure Environment Variables**
   - Add `POLYGON_API_KEY` with your Polygon.io API key
   - Set `PORT` to your desired port (usually 8080)

3. **Build Settings**
   - Build Command: `npm install`
   - Run Command: `npm start`

4. **Deploy**
   - Click deploy and wait for the build to complete

### Environment Variables for Production
```env
POLYGON_API_KEY=your_production_polygon_api_key
PORT=8080
NODE_ENV=production
```

## 📊 Usage Examples

### Get Top Gainers
```bash
curl https://your-app-domain.ondigitalocean.app/gainers
```

### Get Current Price
```bash
curl https://your-app-domain.ondigitalocean.app/price/AAPL
```

### Get OHLCV Data
```bash
curl "https://your-app-domain.ondigitalocean.app/ohlcv/AAPL?multiplier=5&timespan=minute"
```

## 🔒 Security

- API key is stored securely in environment variables
- CORS is configured for controlled access
- Rate limiting can be added for production use

## 📝 License

MIT License - see LICENSE file for details

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📞 Support

For issues and questions, please open an issue on GitHub.
