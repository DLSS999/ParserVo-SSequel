@echo off
echo Supplier Import Sync - install and run dev
echo Checking Node.js version...
node -v

echo Installing dependencies...
npm install
if errorlevel 1 pause && exit /b 1

echo Preparing Prisma database...
npm run setup
if errorlevel 1 pause && exit /b 1

echo Starting Shopify app dev...
shopify app dev
pause
