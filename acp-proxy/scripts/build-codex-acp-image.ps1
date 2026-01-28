param(
  [string]$Runtime = "docker",
  [string]$Tag = "tuixiu-codex-acp:local"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$context = Join-Path $repoRoot "agent-images\\codex-acp"

Write-Host ("[{0}] build {1} from {2} (runtime={3})" -f (Get-Date -Format s), $Tag, $context, $Runtime)

& $Runtime build -t $Tag $context
if ($LASTEXITCODE -ne 0) {
  throw ("image build failed: {0}" -f $LASTEXITCODE)
}

