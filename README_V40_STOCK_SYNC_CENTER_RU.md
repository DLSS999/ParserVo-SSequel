# ParserVo v40 — Stock Sync Center + исправление синхронизации

Что изменено:

1. Stock Sync теперь сделан как отдельный понятный центр управления.
   Основная кнопка: `Start gradual stock sync ALL`.

2. Синхронизация идет постепенно маленькими партиями:
   - 5 товаров
   - 8 товаров
   - 10 товаров

3. Страница показывает прогресс:
   - Processed
   - Synced
   - Synced variants
   - Skipped
   - Failed
   - Remaining

4. Старый опасный сценарий массовой синхронизации на 100+ товаров заменен на безопасную постепенную логику.

5. Ошибки теперь показываются нормально:
   - в Recent Sync Logs добавлен столбец `Error detail`
   - логи больше не пишут только `Failed during gradual Shopify inventory sync`, а сохраняют реальную ошибку Shopify

6. Добавлена кнопка `Clear stock error logs`, которая удаляет только ошибочные логи синхронизации. Товары и успешные логи не удаляются.

7. Исправлено сопоставление Shopify variants / inventory item IDs:
   - сначала по Shopify variant GID
   - потом по SKU
   - потом по Size option
   - потом по одиночному Default Title / UNI товару

8. Добавлена попытка автоматической активации inventory item на Shopify location, если Shopify отвечает, что inventory item не привязан/не stocked на выбранной локации.

Как пользоваться:

1. Открой `ParserVo → Stock Sync Center`.
2. Поставь Batch size = 5 для первого теста.
3. Нажми `Start gradual stock sync ALL`.
4. Не закрывай вкладку, пока идет синхронизация.
5. Если есть ошибки — смотри `Recent Sync Logs → Error detail`.

Важно:

Эта синхронизация НЕ парсит Vitkac заново. Она берет наличие, которое уже сохранено в базе ParserVo, и отправляет его в Shopify inventory.
Для обновления данных из Vitkac сначала нужно обновить товары через Browser Capture / импорт / Excel, а потом запускать Stock Sync Center.
