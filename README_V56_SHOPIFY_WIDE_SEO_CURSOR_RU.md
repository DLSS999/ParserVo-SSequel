# ParserVo v56 — Shopify-wide SEO cursor pagination fix

Исправление для SEO Center.

## Что исправлено

В v55 автоматический Shopify-wide SEO мог остановиться после первой партии, если первые 50 товаров были `Skipped`.

Причина: очередь пыталась пропускать уже обработанные товары через список excluded IDs, но Shopify каждый раз возвращал первые 50 товаров. Если все первые 50 были skipped, система думала, что товаров больше нет.

Теперь Shopify-wide SEO и Vendor/Type update используют настоящую cursor pagination Shopify:

- обрабатывает 10 / 20 / 50 товаров;
- запоминает `endCursor`;
- переходит к следующей партии;
- даже если партия полностью `Skipped`, следующая партия всё равно запускается;
- процесс завершится только когда Shopify реально вернет `hasNextPage = false`.

## Как пользоваться

SEO Center → SEO format для ВСЕХ товаров Shopify → Start automatic SEO update.

Если нужно весь магазин — поле Shopify search query оставить пустым.

Если нужен конкретный бренд:

```text
vendor:'Ami Alexandre Mattiussi'
```

## Установка

```powershell
cd "C:\Users\user\ParserVo CINQ\supplier-import-sync"

npm run build
git add -A
git commit -m "Fix Shopify-wide SEO auto pagination"
git push origin main
```

После деплоя: Ctrl + F5.
