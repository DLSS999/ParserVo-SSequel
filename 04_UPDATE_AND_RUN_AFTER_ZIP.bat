@echo off
echo ParserVo final v8 update: install dependencies, update Prisma schema, run Shopify app dev
npm install
if errorlevel 1 pause
npx prisma db push
if errorlevel 1 pause
npx prisma generate
if errorlevel 1 pause
shopify app dev
pause
