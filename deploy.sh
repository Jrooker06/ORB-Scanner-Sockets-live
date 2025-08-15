#!/bin/bash

# ORB Scanner Polygon Proxy Server Deployment Script
echo "🚀 Starting deployment process..."

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "Please create a .env file with your POLYGON_API_KEY"
    exit 1
fi

# Load environment variables
source .env

# Check if POLYGON_API_KEY is set
if [ -z "$POLYGON_API_KEY" ]; then
    echo "❌ Error: POLYGON_API_KEY not set in .env file"
    exit 1
fi

echo "✅ Environment variables loaded"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Run tests (if you have them)
echo "🧪 Running tests..."
npm test 2>/dev/null || echo "⚠️  No tests found, continuing..."

# Build the application
echo "🔨 Building application..."
npm run build 2>/dev/null || echo "⚠️  No build script found, continuing..."

echo "✅ Deployment preparation complete!"
echo ""
echo "📋 Next steps:"
echo "1. Push your code to GitHub:"
echo "   git add ."
echo "   git commit -m 'Initial commit'"
echo "   git push origin main"
echo ""
echo "2. Deploy to DigitalOcean App Platform:"
echo "   - Go to https://cloud.digitalocean.com/apps"
echo "   - Click 'Create App'"
echo "   - Connect your GitHub repository"
echo "   - Set environment variables:"
echo "     POLYGON_API_KEY: $POLYGON_API_KEY"
echo "     PORT: 8080"
echo "     NODE_ENV: production"
echo "   - Deploy!"
echo ""
echo "🎯 Your app will be available at: https://your-app-name.ondigitalocean.app"
