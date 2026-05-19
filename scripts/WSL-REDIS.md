# Redis on WSL2 (no Docker)

## 1. Install WSL2 + Ubuntu (one time, Admin PowerShell)

```powershell
wsl --install
# Or: wsl --install -d Ubuntu
```

Restart PC if prompted, then open **Ubuntu** from Start menu and create your Linux user.

Update the kernel if needed:

```powershell
wsl --update
```

## 2. Install & start Redis (inside Ubuntu terminal)

```bash
cd /mnt/e/xampp/htdocs/Node-js-CRUD-Generator
bash scripts/redis-wsl-setup.sh
```

Or manually:

```bash
sudo apt update && sudo apt install -y redis-server
sudo service redis-server start
redis-cli ping   # PONG
```

## 3. App `.env` (Windows — same as today)

```env
REDIS_ENABLED=true
REDIS_URL=redis://127.0.0.1:6379
```

Restart `npm run dev`. You should see `✅ Redis connected` in the server log.

## 4. Start Redis after reboot (WSL)

From **PowerShell**:

```powershell
.\scripts\redis-wsl-start.ps1
```

Or in **Ubuntu**:

```bash
sudo service redis-server start
```

## Troubleshooting

| Issue | Fix |
|--------|-----|
| `wsl` not found | Use full path: `C:\Windows\System32\wsl.exe` |
| No distributions | Install Ubuntu from Microsoft Store |
| WSL2 kernel not found | Run `wsl --update` as Admin |
| `ECONNREFUSED` from Node | Run `redis-cli ping` in Ubuntu; start service |
| Still `fromCache: false` | Restart `npm run dev` after Redis is up; call endpoint twice |
