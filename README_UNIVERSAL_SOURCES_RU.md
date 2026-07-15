# ParserVo Universal Sources

Основа: рабочая версия Vitkac. Добавлено:
- Sources: редактирование URL каталогов, валюты, режима парсинга, количества и правил обновления из Shopify admin.
- Stone Island product parser для en-pl / en-gb.
- GBP курс в Settings.
- Import Product распознаёт Vitkac и Stone Island.

## После загрузки
Vercel выполнит `prisma db push` автоматически. Откройте Apps → ParserVo → Sources, проверьте Stone Island URL, затем Import Product и вставьте ссылку конкретного товара. Для сайтов с anti-bot используйте Browser Capture/HTML.

Важно: URL каталога не является URL товара. Сначала он служит конфигурацией источника; товар импортируется по ссылке его карточки. Массовый обход каталога требует отдельного фонового worker, поскольку Vercel не подходит для длительного Playwright-процесса.
