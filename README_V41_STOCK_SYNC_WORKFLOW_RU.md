# ParserVo v41 — Stock Sync workflow fix

Что исправлено:

1. Stock Sync вынесен в одну основную страницу: **ParserVo → Stock Sync Center**.
2. Imported Products больше не содержит отдельную кнопку быстрого Stock Sync — там есть только переход в Stock Sync Center.
3. Добавлена понятная связка:
   - Chrome extension обновляет базу ParserVo через **Start stock refresh**.
   - Потом Stock Sync Center отправляет уже готовые остатки из ParserVo в Shopify через **Push refreshed stock to Shopify**.
4. Синхронизация Shopify идет партиями по 5 / 8 / 10 товаров.
5. Ошибки по отдельным товарам больше не останавливают весь процесс — они пишутся в логи, очередь идет дальше.
6. Исправлен Shopify inventory GraphQL: убран нестабильный `@idempotent`, из-за которого inventory sync мог падать.
7. Улучшено сопоставление Shopify variants / inventory item IDs по variant id, SKU, size и Default Title / UNI.
8. Если inventory item не активен на локации Shopify, приложение пытается активировать его и повторить обновление остатка.

Как использовать:

1. В расширении нажать **Start stock refresh for imported products** — это обновляет наличие в базе ParserVo.
2. В Shopify открыть **ParserVo → Stock Sync Center**.
3. Выбрать **Batch size: 5**.
4. Нажать **Push refreshed stock to Shopify**.
5. Смотреть прогресс и ошибки на этой же странице.

Важно: эта кнопка не парсит Vitkac заново, а только отправляет уже обновленные остатки из ParserVo в Shopify.
