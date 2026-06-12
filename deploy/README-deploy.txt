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

  Copy deploy/pos_admin.htaccess → public_html/pos_admin/.htaccess

STEP 4 — Verify:

  https://testv3.websitedemolynk.com/pos_admin/health
    → MUST return JSON: {"ok":true,"service":"pos-api",...}
    → If you see index.js source or HTML 404, Node/proxy is still wrong.

  https://testv3.websitedemolynk.com/pos_admin/login/admin
    → Admin login HTML page

STEP 5 — Keep Node running after reboot (PM2 startup or cPanel app).
