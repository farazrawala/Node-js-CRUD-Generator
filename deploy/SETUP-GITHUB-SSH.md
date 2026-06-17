# Auto `pm2 restart pos_admin` after every push

FTP upload alone does **not** reload Node. Something on the server must run `deploy/restart-pos-admin.sh` after each deploy.

## Recommended: FTP trigger + root cron (InMotion / cPanel)

GitHub Actions runners often **cannot reach port 22** on shared hosting (`Connection timed out`). FTP still works.

### 1. On the server (as root, one time)

```bash
chmod +x /home/demowebsitv3/public_html/pos_admin/deploy/watch-restart-trigger.sh
crontab -e
```

Add:

```cron
*/1 * * * * sh /home/demowebsitv3/public_html/pos_admin/deploy/watch-restart-trigger.sh >> /var/log/pos_admin_deploy.log 2>&1
```

Every push uploads `deploy/.restart-requested` via FTP. Within ~1 minute cron runs `restart-pos-admin.sh` (`npm ci` + `pm2 restart pos_admin`).

### 2. Push to `main`

No GitHub SSH secret required for this path.

### 3. Verify

```bash
curl -s https://testv3.websitedemolynk.com/pos_admin/api/version
```

After deploy, `version.processUptimeSec` should drop within about a minute.

---

## Optional: instant restart via SSH

Only works if **root SSH on port 22 is open to GitHub Actions** (often blocked on shared hosting).

### 1. On the server (as root)

```bash
mkdir -p /root/.ssh
chmod 700 /root/.ssh
ssh-keygen -t ed25519 -f /root/.ssh/github_deploy -N ""
cat /root/.ssh/github_deploy.pub >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
cat /root/.ssh/github_deploy
```

### 2. In GitHub repo

**Settings** → **Secrets and variables** → **Actions** → environment or repository secret:

- Name: `SSH_PRIVATE_KEY`
- Value: full private key from above

Optional variables (same environment or repository **Variables**):

| Name | Default | Purpose |
|------|---------|---------|
| `SSH_HOST` | `192.249.118.80` | SSH hostname or IP |
| `SSH_PORT` | `22` | SSH port |
| `SSH_USER` | `root` | SSH user |

The workflow uses `environment: SSH_PRIVATE_KEY` when that environment exists.

### 3. Workflow behavior

1. FTP upload (always)
2. Try SSH restart (instant if port 22 reachable)
3. If SSH fails, cron trigger still restarts within ~1 minute

---

## Manual restart

```bash
# As root only (demowebsitv3 PM2 cannot see root's pos_admin)
cd /home/demowebsitv3/public_html/pos_admin
sh deploy/restart-pos-admin.sh
```
