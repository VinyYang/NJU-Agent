# NJU CodePilot Windows launcher (PowerShell).
# Starts the stdlib backend, waits until /health responds, and opens the
# bundled frontend.  Provider credentials are read from the ignored .env by
# the backend itself; this script never embeds or writes an API key.

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Port = if ($env:AGENT_PORT) { [int]$env:AGENT_PORT } else { 8124 }
$Workspace = if ($env:AGENT_WORKSPACE) { $env:AGENT_WORKSPACE } else { $Root }
$Url = "http://127.0.0.1:$Port/"

# Fresh sources are served with a cache-busting query string so a browser
# refresh after an update never shows stale frontend assets.
$backend_source = Get-Item (Join-Path $Root "backend\server.py")
$expectedBackend = $backend_source.LastWriteTimeUtc
$cacheBust = [int][double]::Parse($expectedBackend.ToString("yyyyMMddHHmmss"))
$FrontendUrl = "http://127.0.0.1:$Port/agent?v=$cacheBust"

function Get-PortProcessIds {
  param([int]$PortNumber = $script:Port)
  try {
    Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    @()
  }
}

# A stale backend from an earlier run would hold the port and confuse the
# demo.  Stop only the process listening on our port, then wait for it to
# release the socket before starting a fresh backend.
$ids = Get-PortProcessIds
if ($ids) {
  Write-Host "Stopping stale backend process(es) on port $Port..."
  Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-PortProcessIds) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
}

Write-Host "NJU CodePilot starting on $Url (workspace: $Workspace)"
$process = Start-Process -FilePath (Get-Command python).Source `
  -ArgumentList @("-m", "backend", "--host", "127.0.0.1", "--port", "$Port", "--workspace", "$Workspace") `
  -WorkingDirectory $Root -WindowStyle Hidden -PassThru

function Wait-ForHealthyService {
  param([int]$PortNumber, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$PortNumber/health" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return $true }
    } catch { Start-Sleep -Milliseconds 400 }
  }
  return $false
}

if (Wait-ForHealthyService -PortNumber $Port) {
  Write-Host "Backend healthy; opening $FrontendUrl"
  Start-Process $FrontendUrl
} else {
  Write-Host "Backend did not become healthy within the timeout. Check backend.log / stderr."
  exit 1
}
