# ParserVo v44 — background stock sync

Что исправлено:

1. Stock Sync теперь запускается как фоновая очередь, а не как длинный процесс на одной странице.
2. Можно нажать **Start background push to Shopify** и перейти на Imported Products / Settings / Sync Logs — синхронизация будет продолжаться, пока открыто приложение ParserVo.
3. Очередь хранит прогресс в базе через SyncLog: processed, synced, skipped, failed, remaining.
4. Добавлен новый JSON endpoint: `/api/stock-sync-job`.
5. Добавлен глобальный runner в `app/routes/app.tsx`, который двигает очередь на любой странице ParserVo.
6. Старый v36 не использовался.
7. В ZIP также сохранены fixes v42 и pagination v43.

Важно: если полностью закрыть вкладку Shopify/ParserVo, фоновая очередь поставится на паузу и продолжит работу после повторного открытия ParserVo.
