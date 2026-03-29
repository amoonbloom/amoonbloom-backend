# Stops whatever process is listening on TCP port 5000 (Windows).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/kill-port-5000.ps1
$port = 5000
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) {
  Write-Host "No process is listening on port $port."
  exit 0
}
foreach ($l in $listeners) {
  $procId = $l.OwningProcess
  try {
    $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName
    Stop-Process -Id $procId -Force
    Write-Host "Stopped $name (PID $procId) on port $port."
  } catch {
    Write-Host "Could not stop PID ${procId}: $_"
    exit 1
  }
}
