# Start Redis in WSL from Windows PowerShell (after Ubuntu is installed).
$wsl = "$env:SystemRoot\System32\wsl.exe"
if (-not (Test-Path $wsl)) {
  Write-Error "WSL not found. Install WSL2 first (see scripts/WSL-REDIS.md)."
  exit 1
}

$list = & $wsl -l -q 2>&1 | Out-String
if ($list -match "no installed distributions" -or [string]::IsNullOrWhiteSpace($list.Trim())) {
  Write-Host ""
  Write-Host "WSL has no Linux distro yet. Install Ubuntu first (Admin PowerShell):" -ForegroundColor Yellow
  Write-Host "  wsl --install -d Ubuntu" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Or open Microsoft Store and install 'Ubuntu', then restart PC if asked."
  Write-Host "After Ubuntu opens, run: bash scripts/redis-wsl-setup.sh"
  Write-Host "See scripts/WSL-REDIS.md"
  exit 1
}

& $wsl -e bash -lc "sudo service redis-server start 2>/dev/null || sudo service redis start; redis-cli ping"
if ($LASTEXITCODE -eq 0) {
  Write-Host "Redis should be reachable at redis://127.0.0.1:6379"
}
