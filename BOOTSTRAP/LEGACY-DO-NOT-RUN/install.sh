#!/bin/bash

echo "----------------------------------------"
echo " Thumbnail Scraper Project Installer"
echo "----------------------------------------"

# Create server .env
echo "Creating server/.env..."
mkdir -p server
cat > server/.env <<EOF
PORT=4000
USER_AGENT=Mozilla/5.0
EOF

# Create client .env
echo "Creating client/.env..."
mkdir -p client
cat > client/.env <<EOF
VITE_API_URL=http://localhost:4000
EOF

# Install backend dependencies
echo "Installing backend dependencies..."
cd server
npm install express axios cheerio cors dotenv
cd ..

# Install frontend dependencies
echo "Installing frontend dependencies..."
cd client
npm install axios
cd ..

echo "----------------------------------------"
echo " Installation complete!"
echo " Run the backend with:  cd server && node index.js"
echo " Run the frontend with: cd client && npm run dev"
echo "----------------------------------------"