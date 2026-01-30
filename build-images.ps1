$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath .
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

$serviceImage = "yoke233/tuixiu-service"
$proxyImage = "yoke233/tuixiu-acp-proxy"

Write-Host "Building ${serviceImage}:latest and ${serviceImage}:$timestamp"
docker build `
  -f "$repoRoot\Dockerfile" `
  -t "${serviceImage}:latest" `
  -t "${serviceImage}:$timestamp" `
  "$repoRoot"

Write-Host "Building ${proxyImage}:latest and ${proxyImage}:$timestamp"
docker build `
  -f "$repoRoot\acp-proxy\Dockerfile" `
  -t "${proxyImage}:latest" `
  -t "${proxyImage}:$timestamp" `
  "$repoRoot"
