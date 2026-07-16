# ParserVo SSEQUEL v2

Модульное Shopify-приложение и набор независимых парсеров.

> Production restore: стабильная Vercel-конфигурация восстановлена 16.07.2026.

## Что изменено
- Shopify-приложение и существующая авторизация сохранены.
- YNAP-парсер оставлен отдельной командой.
- Добавлен независимый Stone Island Sale parser.
- Общие типы, runner, ограничение параллельности, повторные попытки и JSON-журнал ошибок вынесены в `app/parsers/core`.
- Worker теперь умеет выполнять Stone Island jobs через BullMQ; без Redis локальный запуск не ломается.
- Результат Stone Island сохраняется в `data/stone-island/products.json`, `errors.json`, `summary.json`.

## Установка
```bash
npm install
npx playwright install chromium
npx prisma generate
```

## Быстрая проверка одного товара
Windows PowerShell:
```powershell
$env:MAX_PRODUCTS="1"
$env:CRAWL_CONCURRENCY="1"
npm run crawl:stone-island
```

Полный каталог:
```powershell
Remove-Item Env:MAX_PRODUCTS -ErrorAction SilentlyContinue
npm run crawl:stone-island
```

## Команды
- `npm run dev` — Shopify App
- `npm run build` — production build
- `npm run typecheck` — TypeScript validation
- `npm run crawl:stone-island` — Stone Island Sale
- `npm run crawl:ynap` — старый YNAP crawler
- `npm run worker` — BullMQ worker, если задан `REDIS_URL`

## Безопасность
Файл `.env` не должен попадать в Git или ZIP. В репозитории хранится только `.env.example`.

## Архитектура нового парсера
Каждый новый источник реализует `MarketplaceParser`:
- `collectProductUrls()`
- `parseProduct()`

Это позволяет добавлять сайты независимо, не переписывая Shopify-приложение.
