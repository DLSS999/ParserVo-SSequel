# ParserVo v3

Чистое Shopify-приложение для импорта и синхронизации товаров поставщиков.

## Основные разделы
- Sources — URL, валюта, курс, наценка и правила каждого источника.
- Import Product — импорт отдельной карточки через URL/Browser Capture.
- Excel Import — массовый импорт.
- Imported Products — каталог базы.
- Stock Sync — обновление наличия.
- Settings — общие курсы и Shopify Location.

## Vercel
1. Node.js Version: 22.x.
2. Environment Variables: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL, SCOPES, DATABASE_URL.
3. Build: `npm run vercel-build`.
4. После первого успешного деплоя выполнить `npx prisma db push` локально либо временно использовать `npm run setup` с production DATABASE_URL.

В `vercel-build` намеренно нет `prisma db push`, чтобы production-сборка не изменяла схему базы автоматически.
