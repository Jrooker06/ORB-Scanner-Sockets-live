# 🚀 Deployment Guide

## GitHub Setup

### 1. Create New Repository
1. Go to [GitHub](https://github.com) and create a new repository
2. Name it something like `orb-scanner-proxy` or `polygon-proxy-server`
3. Make it public or private (your choice)
4. Don't initialize with README (we already have one)

### 2. Push Your Code
```bash
# Navigate to your project directory
cd "live data scan test/github files 2.0"

# Initialize git repository
git init

# Add all files
git add .

# Make initial commit
git commit -m "Initial commit: ORB Scanner Polygon Proxy Server"

# Add remote origin (replace with your actual repo URL)
git remote add origin https://github.com/your-username/your-repo-name.git

# Push to GitHub
git push -u origin main
```

## DigitalOcean App Platform Deployment

### 1. Access DigitalOcean
1. Go to [DigitalOcean Cloud](https://cloud.digitalocean.com)
2. Navigate to "Apps" section
3. Click "Create App"

### 2. Connect GitHub Repository
1. Choose "GitHub" as source
2. Connect your GitHub account if not already connected
3. Select your repository: `your-username/your-repo-name`
4. Select branch: `main`

### 3. Configure App Settings
1. **App Name**: `orb-scanner-proxy` (or your preferred name)
2. **Environment**: `Node.js`
3. **Build Command**: `npm install`
4. **Run Command**: `npm start`

### 4. Set Environment Variables
Add these environment variables:
- `POLYGON_API_KEY`: `iY4cpZRjJpHvHJpVaRKzbAUUXdlH3egP`
- `PORT`: `8080`
- `NODE_ENV`: `production`

### 5. Deploy
1. Click "Create Resources"
2. Wait for build and deployment to complete
3. Your app will be available at: `https://your-app-name.ondigitalocean.app`

## Testing Your Deployed App

### Health Check
```bash
curl https://your-app-name.ondigitalocean.app/health
```

### Test Market Data
```bash
curl https://your-app-name.ondigitalocean.app/gainers
```

### Test Symbol Data
```bash
curl https://your-app-name.ondigitalocean.app/price/AAPL
```

## Update Your Python Client

Once deployed, update your Python scanner to use the new URL:

```python
# Change this line in your Python code
API_BASE_URL = "https://your-app-name.ondigitalocean.app"
```

## Monitoring & Maintenance

### View Logs
- Go to your DigitalOcean app dashboard
- Click on "Runtime Logs" to see real-time logs

### Scale Up/Down
- Modify instance count and size in app settings
- Basic-XXS is good for development, consider Basic-S for production

### Environment Variable Updates
- Modify environment variables in app settings
- Changes require redeployment

## Troubleshooting

### Common Issues
1. **Build Fails**: Check that all dependencies are in package.json
2. **Runtime Errors**: Check environment variables are set correctly
3. **Port Issues**: Ensure PORT is set to 8080 in environment variables

### Support
- Check DigitalOcean app logs for detailed error messages
- Verify your Polygon API key is valid and has sufficient credits
