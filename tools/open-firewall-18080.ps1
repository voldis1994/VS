# Open Windows Firewall for VS client panel (DuckDNS / port-forward test).
# Run once as Administrator:
#   powershell -ExecutionPolicy Bypass -File tools\open-firewall-18080.ps1
# Remove:
#   Remove-NetFirewallRule -DisplayName "VS Client Panel 18080"

$ErrorActionPreference = 'Stop'
$name = 'VS Client Panel 18080'
$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[OK] Firewall rule already exists: $name"
  exit 0
}
New-NetFirewallRule `
  -DisplayName $name `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 18080 `
  -Action Allow `
  -Profile Any | Out-Null
Write-Host "[OK] Allowed inbound TCP 18080 ($name)"
Write-Host "     Router: forward WAN 18080 -> this PC LAN IP :18080"
Write-Host "     Test from mobile DATA: http://vs-system.duckdns.org:18080"
