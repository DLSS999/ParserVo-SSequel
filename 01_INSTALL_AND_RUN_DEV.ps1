Write-Host "Supplier Import Sync — install and run dev" -ForegroundColor Cyan
Write-Host "Checking Node.js version..." -ForegroundColor Cyan
node -v

Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm install

Write-Host "Preparing Prisma database..." -ForegroundColor Cyan
npm run setup

Write-Host "Starting Shopify app dev..." -ForegroundColor Cyan
shopify app dev
