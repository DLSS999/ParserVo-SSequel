# ParserVo v42 — Fix Stock Sync GraphQL UserError.code

Исправляет ошибку при отправке остатков в Shopify:

`Field 'code' doesn't exist on type 'UserError'`

Причина: Shopify API для некоторых inventory mutations возвращает обычный `UserError`, где есть `field` и `message`, но нет поля `code`. Из-за запроса поля `code` вся GraphQL mutation падала до обновления остатков.

Что изменено:

- убрано поле `code` из GraphQL `userErrors` selection set;
- исправлены inventory mutations `inventorySetQuantities` и `inventoryActivate`;
- дополнительно убрано `code` из других mutation selection set в `shopify-products.server.ts`, чтобы не ловить аналогичную ошибку на разных версиях Shopify API;
- логика Stock Sync Center из v41 сохранена.

Установка:

1. Распаковать ZIP в корень проекта `supplier-import-sync` с заменой файлов.
2. Выполнить:

```powershell
npm run build
git add -A
git commit -m "Fix Shopify UserError code field in stock sync"
git push origin main
```

После деплоя:

1. Открыть Shopify Admin → ParserVo → Stock Sync Center.
2. Нажать Ctrl + F5.
3. Нажать Clear stock error logs.
4. Batch size поставить 5.
5. Нажать Push refreshed stock to Shopify.
