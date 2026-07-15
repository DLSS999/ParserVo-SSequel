# ParserVo v8 — Excel Import + Stock Sync

Эта версия добавляет две страницы:

1. **Excel Import** — загрузка Excel/CSV со ссылками Vitkac и очередь импорта.
2. **Stock Sync** — загрузка Excel/CSV с остатками по размерам для обновления статуса наличия в базе приложения.

## Установка поверх текущей папки

1. Останови приложение: `q` или `Ctrl + C`.
2. Скопируй файлы из архива поверх текущей папки:
   `C:\Users\user\ParserVo\supplier-import-sync`
3. Самый простой запуск через PowerShell:

```powershell
.\04_UPDATE_AND_RUN_AFTER_ZIP.bat
```

Или вручную:

```powershell
npm install
npx prisma db push
npx prisma generate
shopify app dev
```

## Excel Import — формат файла

Можно использовать `.xlsx`, `.xls`, `.csv`.

Главная колонка:

```csv
supplier_url
https://www.vitkac.com/pl/p/dress-cocco-cult-gaia-dress-blk-1810796
```

Также поддерживаются названия колонок: `url`, `link`, `product_url`, `vitkac_url`, `посилання`, `ссылка`.

После загрузки файла:

1. Открой `/app/excel-import`.
2. Нажми `Open first 10 queued links`.
3. Откроются вкладки Vitkac.
4. Нажми расширение ParserVo Vitkac Capture.
5. Нажми `Capture all open Vitkac tabs`.
6. Товары появятся в `Imported Products`.

## Stock Sync — формат файла

```csv
supplier_product_id,symbol,size,quantity,available,price,currency
1810796,DR3250YMX558-0-BLK,0,1,true,2368,PLN
1810796,DR3250YMX558-0-BLK,2,0,false,2368,PLN
1665725,755341 AACG0-1000,35,1,true,5069,PLN
```

Поиск товара идет по:

- `supplier_product_id`
- `symbol`
- `model_code`

Поиск размера идет по:

- `size`
- `supplierSizeLabel`

Если у товара остался хотя бы один доступный размер, статус становится:

- `stockSourceStatus = supplier_available`
- `status = active`

Если нет доступных размеров:

- `stockSourceStatus = supplier_sold_out`
- `status = drafted_by_sync`

## Важно

Эта версия обновляет наличие в базе приложения и Sync Logs. Обновление Shopify Inventory будет подключаться после полноценного создания Shopify Product и сохранения `shopifyInventoryItemId` для каждого размера.


## Шаблоны файлов

В папке `templates` лежат готовые шаблоны:

- `vitkac_links_template.xlsx` — Excel со ссылками для массового импорта.
- `stock_sync_template.xlsx` — Excel с остатками по размерам.
- `vitkac_links_template.csv` — CSV со ссылками.
- `stock_sync_template.csv` — CSV с остатками.
