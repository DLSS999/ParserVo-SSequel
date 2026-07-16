# ParserVo Universal — Vitkac + Stone Island

## Исправление Vercel
- Node.js зафиксирован на 22.x.
- package-lock.json синхронизирован с package.json.
- Vercel устанавливает зависимости через npm ci без postinstall-скриптов.
- Prisma Client генерируется на этапе build.
- Playwright browser не скачивается во время npm install.

## Новое в админке
- Раздел Sources.
- Изменяемый URL каталога.
- Валюта и индивидуальный курс источника.
- Наценка, количество, режим parser/browser capture.
- Правила автоимпорта, обновления и скрытия отсутствующих.
- Предустановлены Vitkac и Stone Island Poland Sale.
- Import Product принимает ссылки Vitkac и Stone Island.
- Добавлены курсы GBP и USD в Settings.

## После деплоя
Откройте Apps → ParserVo → Sources и сохраните параметры источников.
Для Stone Island рекомендуется Browser Capture / HTML import, если сайт блокирует серверный запрос.
