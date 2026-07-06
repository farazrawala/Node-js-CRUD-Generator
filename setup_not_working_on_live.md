What to run on the server

1. See what PM2 actually has:

pm2 list
You might see pos-api, another name, or nothing.

2. Start or restart (recommended — use the project script):

cd /home/demowebsitv3/public_html/pos_admin
sh deploy/restart-pos-admin.sh
That script installs deps, then either pm2 restart pos_admin or pm2 start index.js --name pos_admin if it doesn’t exist yet.

3. Or start manually:

cd /home/demowebsitv3/public_html/pos_admin
npm ci --omit=dev # or: npm install --omit=dev
pm2 start index.js --name pos_admin
pm2 save 4. Confirm it’s up:

pm2 list
pm2 logs pos_admin --lines 30
curl -s http://127.0.0.1:8000/health 5. In the browser:

https://testv3.websitedemolynk.com/pos_admin/health
https://testv3.websitedemolynk.com/pos_admin/login/admin
Notes
Topic Detail
Wrong name
index.js mentions pos-api in one error message; deploy uses pos_admin. Use pos_admin consistently.
.env
Needs PORT=8000, BASE_PATH=/pos_admin, MONGODB_URI_LIVE=..., etc. (see deploy/README-deploy.txt).
User
Restart as root if that’s who owns PM2; demowebsitv3 often can’t restart root’s PM2.
After reboot
Run once: pm2 startup then pm2 save so it survives reboot.
If start fails
Check logs:

pm2 logs pos_admin --err --lines 50
Typical failures: missing .env, MongoDB URI wrong, broken node_modules (run sh deploy/reinstall-deps.sh).

Paste the output of pm2 list and the first lines of pm2 logs pos_admin if it still won’t start.
