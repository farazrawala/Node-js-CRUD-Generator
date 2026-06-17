# One-time setup: auto `pm2 restart pos_admin` after every push

Without SSH, GitHub Actions only **uploads files** (FTP). Node keeps running **old code** until you restart PM2.

## 1. On the server (as root)

```bash
# Ensure root can SSH in with a key (not password)
mkdir -p /root/.ssh
chmod 700 /root/.ssh

# Generate a deploy key (press Enter for no passphrase)
ssh-keygen -t ed25519 -f /root/.ssh/github_deploy -N ""

# Allow the key to log in as root
cat /root/.ssh/github_deploy.pub >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

# Show private key — copy ALL lines including BEGIN/END
cat /root/.ssh/github_deploy
```

## 2. In GitHub repo

1. **Settings** → **Secrets and variables** → **Actions**
2. Either:
   - **Repository secrets** → **New repository secret**, name `SSH_PRIVATE_KEY`, **or**
   - **Environments** → create/select environment `SSH_PRIVATE_KEY` → add secret `SSH_PRIVATE_KEY`
3. Value: paste the full private key from step 1

The workflow uses `environment: SSH_PRIVATE_KEY`, so an environment secret with that name works. A repository secret named `SSH_PRIVATE_KEY` also works (GitHub exposes it to the job).

## 3. Push to `main`

The workflow will:

1. FTP upload files
2. SSH as `root@192.249.118.80`
3. Run `deploy/restart-pos-admin.sh` → `npm ci` + `pm2 restart pos_admin`

## 4. Verify

```bash
curl -s https://testv3.websitedemolynk.com/pos_admin/api/version
```

Check `version.processUptimeSec` is low (seconds) right after deploy.

## Manual restart (if SSH secret missing)

```bash
# As root only (demowebsitv3 PM2 cannot see root's pos_admin)
cd /home/demowebsitv3/public_html/pos_admin
sh deploy/restart-pos-admin.sh
```
