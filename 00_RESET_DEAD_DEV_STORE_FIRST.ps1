Write-Host "ParserVo: reset old/deleted dev store link" -ForegroundColor Cyan
Write-Host "Target live store for installation: 2szizg-0m.myshopify.com" -ForegroundColor Cyan
Write-Host "This removes only local Shopify CLI cache. It does NOT delete your ParserVo database." -ForegroundColor Yellow

if (Test-Path ".shopify") {
  Write-Host "Removing .shopify local CLI cache..." -ForegroundColor Yellow
  Remove-Item -Recurse -Force ".shopify"
}

Write-Host "Re-linking app configuration. Choose app: ParserVo" -ForegroundColor Cyan
Write-Host "If asked for a preview/development store, choose/create any DEVELOPMENT store, not the live store." -ForegroundColor Yellow
shopify app config link --reset
if ($LASTEXITCODE -ne 0) { Read-Host "Press Enter to exit"; exit $LASTEXITCODE }

Write-Host "Pulling app environment..." -ForegroundColor Cyan
shopify app env pull

Write-Host "Installing dependencies and preparing database..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { Read-Host "Press Enter to exit"; exit $LASTEXITCODE }
npm run setup
if ($LASTEXITCODE -ne 0) { Read-Host "Press Enter to exit"; exit $LASTEXITCODE }

Write-Host "Starting Shopify app dev with reset. Choose a DEVELOPMENT store for CLI preview." -ForegroundColor Cyan
Write-Host "Do NOT use deleted checkvo-import-test.myshopify.com." -ForegroundColor Yellow
shopify app dev --reset
