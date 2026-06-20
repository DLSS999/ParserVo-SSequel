# ParserVo Shopify App

Embedded Shopify app for parsing and importing products from:
- NET-A-PORTER / Women
- MR PORTER / Men

## MVP modules
- Dashboard with category blocks
- Category parser via Playwright
- Product preview DB storage
- Image template service placeholder
- Shopify import service should be connected after app auth setup

## Setup
1. `npm install`
2. Create `.env` from `.env.example`
3. `npx prisma generate`
4. `npx prisma migrate dev`
5. `npm run dev`

## Notes
Filtered URLs for some categories are shortened in seed file. Replace Shoes/Bags/Accessories with full filtered URLs from your table before production parsing.
