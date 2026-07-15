Write-Host "ParserVo final v8 update: install dependencies, update Prisma schema, run Shopify app dev"
npm install
npx prisma db push
npx prisma generate
shopify app dev
