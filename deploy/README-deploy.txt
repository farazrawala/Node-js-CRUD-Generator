POS API — deploy under https://yourdomain.com/pos_admin
============================================================

PROBLEM: /pos_admin/ shows index.js source code → Apache is serving files; Node is NOT running.

STEP 1 — On the server (SSH), in the project folder (NOT only public_html):

  npm install
  cp .env.example .env   # or upload your .env

  Required .env:
    APP_ENV=live
    BASE_PATH=/pos_admin
    BASE_URL=https://testv3.websitedemolynk.com/pos_admin
    PORT=8000
    NODE_ENV=production
    MONGODB_URI_LIVE=mongodb://...

STEP 2 — Start Node (pick one):

  A) PM2 (recommended):
     npm install -g pm2
     pm2 start index.js --name pos-api
     pm2 save
     pm2 startup

  B) cPanel → "Setup Node.js App":
     - Application root: folder containing index.js
     - Application URL: pos_admin
     - Application startup file: index.js
     - Add env vars from .env in the cPanel UI
     - Click "Run NPM Install" then "Start App"
     - Do NOT rely on public_html serving .js files

STEP 3 — Apache proxy (if not using cPanel Node app):

  .htaccess is in the repo root and deploys via FTP to public_html/pos_admin/.
  (Strips /pos_admin before proxy; DirectoryIndex disabled so index.js is not served as text.)

  If the site still shows index.js source, on the server run:
    cd /home/demowebsitv3/public_html/pos_admin
    cp deploy/pos_admin.htaccess .htaccess   # only if .htaccess missing after deploy

  IMPORTANT: After ANY code change, upload files and RESTART Node:
    pm2 restart pos-api
  cPanel often does NOT read .env from disk — add BASE_PATH=/pos_admin in
  cPanel Node.js "Environment variables" anyway. New code also auto-strips
  /pos_admin from proxied URLs even if BASE_PATH is missing.

STEP 4 — Verify:

  https://testv3.websitedemolynk.com/pos_admin/health
    → MUST return JSON: {"ok":true,"service":"pos-api",...}
    → If you see index.js source or HTML 404, Node/proxy is still wrong.

  https://testv3.websitedemolynk.com/pos_admin/login/admin
    → Admin login HTML page

STEP 5 — Keep Node running after reboot (PM2 startup or cPanel app).

FIX — "Cannot find module '../encodings'" (iconv-lite) on POST /user/login:

  FTP does NOT upload node_modules. npm install must run ON THE SERVER after deploy.
  If SSH from GitHub Actions fails, run in cPanel Terminal:

    cd /home/demowebsitv3/public_html/pos_admin
    sh deploy/reinstall-deps.sh
    pm2 restart pos-api

  Or manually:
    rm -rf node_modules
    npm ci --omit=dev
    pm2 restart pos-api

  cPanel alternative: Setup Node.js App → "Run NPM Install" → restart app.

DEBUG LOGS — download to rectify live issues:

  Easiest (browser, after admin login):
    https://testv3.websitedemolynk.com/pos_admin/admin/debug/logs/page

  Or set in server .env: DEBUG_LOG_KEY=your-secret-key
    https://testv3.websitedemolynk.com/pos_admin/admin/debug/logs/page?key=your-secret-key

  JSON list:
    GET /pos_admin/admin/debug/logs
    GET /pos_admin/api/debug/logs  (Authorization: Bearer <admin-token>)

  Download:
    GET /pos_admin/admin/debug/logs/download?file=app-YYYY-MM-DD.log

  Or cPanel File Manager: public_html/pos_admin/logs/
