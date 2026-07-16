param(
  [string]$Category = "all",
  [int]$MaxProducts = 0,
  [switch]$SkipShopify,
  [switch]$InstallDependencies
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Import-WorkerEnv {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    throw "Missing $Path. Copy .env.worker.example to .env.worker and fill the secret values."
  }

  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $separator = $line.IndexOf("=")
    if ($separator -lt 1) { return }
    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

function Require-Env {
  param([string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Environment variable $Name is missing in .env.worker"
  }
}

$lockPath = Join-Path $repoRoot ".parservo-worker.lock"
if (Test-Path $lockPath) {
  throw "ParserVo worker is already running. Lock file: $lockPath"
}

New-Item -ItemType File -Path $lockPath -Force | Out-Null

try {
  Import-WorkerEnv (Join-Path $repoRoot ".env.worker")
  Require-Env "SUPABASE_SECRET_KEY"

  $env:CRAWL_CATEGORY = $Category
  $env:MAX_PRODUCTS = [string]$MaxProducts
  if ([string]::IsNullOrWhiteSpace($env:CRAWL_CONCURRENCY)) { $env:CRAWL_CONCURRENCY = "3" }
  if ([string]::IsNullOrWhiteSpace($env:CRAWL_HEADLESS)) { $env:CRAWL_HEADLESS = "false" }
  if ([string]::IsNullOrWhiteSpace($env:CRAWL_BROWSER_CHANNEL)) { $env:CRAWL_BROWSER_CHANNEL = "chrome" }

  $logDirectory = Join-Path $repoRoot "logs"
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $logPath = Join-Path $logDirectory "parservo-$timestamp.log"

  Write-Host "ParserVo local worker"
  Write-Host "Category: $Category"
  Write-Host "Max products: $MaxProducts"
  Write-Host "Log: $logPath"

  if ($InstallDependencies -or -not (Test-Path (Join-Path $repoRoot "node_modules"))) {
    & npm install --legacy-peer-deps 2>&1 | Tee-Object -FilePath $logPath -Append
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with code $LASTEXITCODE" }
  }

  Write-Host "Starting catalog crawl through local Chrome..."
  & npm run crawl:catalog 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "Catalog crawl failed with code $LASTEXITCODE. See $logPath" }

  if (-not $SkipShopify) {
    Require-Env "SHOPIFY_API_KEY"
    Require-Env "SHOPIFY_API_SECRET"
    Require-Env "SHOPIFY_SHOP_DOMAIN"

    Write-Host "Starting automatic Shopify synchronization..."
    & npm run sync:shopify 2>&1 | Tee-Object -FilePath $logPath -Append
    if ($LASTEXITCODE -ne 0) { throw "Shopify synchronization failed with code $LASTEXITCODE. See $logPath" }
  }

  Write-Host "ParserVo finished successfully."
}
finally {
  Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
}
