Thumbnail Preview Scraper
A lightweight full-stack project that generates Bing-style thumbnail previews for any URL. The backend scrapes metadata (OpenGraph, Twitter Cards, VideoObject) and the frontend displays a clean, responsive grid of thumbnails.
Features
- Extracts thumbnails from any website using:
- og:image
- twitter:image
- og:image:url
- og:image:secure_url
- <video poster="">
- Extracts page titles for cleaner previews
- Fully CORS-safe (browser never fetches external sites directly)
- React frontend with a responsive tile grid
- Clickable tiles open the original URL
- Environment-based configuration for both client and server
- Clean .gitignore for both apps
Project Structure
your-project/
├── client/                 # React + Vite frontend
│   ├── src/
│   ├── public/
│   ├── .env                # Frontend environment variables
│   ├── package.json
│   └── vite.config.js
│
├── server/                 # Node + Express backend scraper
│   ├── index.js
│   ├── .env                # Backend environment variables
│   ├── package.json
│   └── node_modules/
│
└── README.md


Backend Setup (Node + Express)
1. Install dependencies
cd server
npm install


2. Create .env
PORT=4000
USER_AGENT=Mozilla/5.0


3. Start the server
node index.js


Backend runs at:
http://localhost:4000


Frontend Setup (React + Vite)
1. Install dependencies
cd client
npm install


2. Create .env
VITE_API_URL=http://localhost:4000


3. Start the frontend
npm run dev


Frontend runs at:
http://localhost:5173


How the System Works
The frontend never fetches external sites directly.
Instead, it sends each URL to the backend via:
POST /scrape


The backend:
- Downloads the HTML
- Parses metadata using Cheerio
- Extracts thumbnail and title
- Returns JSON to the frontend
The frontend displays a tile with:
- Thumbnail
- Title
- Click → opens original URL
This architecture avoids CORS issues and mirrors how search engines generate previews.
Example Response From Backend
{
  "url": "https://example.com/video",
  "title": "Example Video Title",
  "thumbnail": "https://example.com/thumb.jpg"
}


.gitignore (Client + Server)
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

.env
.env.local
.env.*.local

logs/
*.log
*.log.*
debug.log

dist/
build/
.cache/
.vite/

.DS_Store
Thumbs.db

.vscode/
.idea/

*.tmp
*.temp
*.swp
*.swo

coverage/


Technologies Used
- React 18
- Vite
- Axios
- Node.js
- Express
- Cheerio
- CORS
- Environment variables (.env)
Future Enhancements
- Caching (Redis or filesystem)
- Database for saved collections
- Hover-to-preview animations
- Skeleton loading states
- Deployment to Render / Fly.io / Vercel / Netlify
