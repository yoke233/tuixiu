$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath .
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

$backendImage = "yoke233/tuixiu-backend"
$frontendImage = "yoke233/tuixiu-frontend"
$proxyImage = "yoke233/tuixiu-acp-proxy"

Write-Host "Building ${backendImage}:latest and ${backendImage}:$timestamp"
docker build `
  -f "$repoRoot\backend\Dockerfile" `
  -t "${backendImage}:latest" `
  -t "${backendImage}:$timestamp" `
  "$repoRoot"

Write-Host "Building ${frontendImage}:latest and ${frontendImage}:$timestamp"
docker build `
  -f "$repoRoot\frontend\Dockerfile" `
  -t "${frontendImage}:latest" `
  -t "${frontendImage}:$timestamp" `
  "$repoRoot"

Write-Host "Building ${proxyImage}:latest and ${proxyImage}:$timestamp"
docker build `
  -f "$repoRoot\acp-proxy\Dockerfile" `
  -t "${proxyImage}:latest" `
  -t "${proxyImage}:$timestamp" `
  "$repoRoot"
