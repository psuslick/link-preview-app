Write-Host "----------------------------------------"
Write-Host " Thumbnail Scraper Project Installer"
Write-Host "----------------------------------------"

# Create server .env
Write-Host "Creating server/.env..."
New-Item -ItemType Directory -Force -Path "server" | Out-Null
@"
PORT=4000
USER_AGENT=Mozilla/5.0
"@ | Set-Content "server/.env"

# Create client .env
Write-Host "Creating client/.env..."
New-Item -ItemType Directory -Force -Path "client" | Out-Null
@"
VITE_API_URL=http://localhost:4000
"@ | Set-Content "client/.env"

# Install backend dependencies
Write-Host "Installing backend dependencies..."
Set-Location "server"
npm install express axios cheerio cors dotenv
Set-Location ".."

# Install frontend dependencies
Write-Host "Installing frontend dependencies..."
Set-Location "client"
npm install axios
Set-Location ".."

Write-Host "----------------------------------------"
Write-Host " Installation complete!"
Write-Host " Run the backend with:  cd server && node index.js"
Write-Host " Run the frontend with: cd client && npm run dev"
Write-Host "----------------------------------------"