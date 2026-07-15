# ParserVo v47 — Warehouse Transfer by Shopify Tag

Добавлена новая страница:

`ParserVo → Warehouse Transfer`

## Что делает

Позволяет перенести остатки между складами Shopify по выбранному тегу.

Логика полного переноса:

1. Выбираешь склад, с которого нужно перенести наличие.
2. Выбираешь склад, на который нужно перенести наличие.
3. Выбираешь Shopify tag, например `Vitkac`, `PreOrder`, `full_payment`.
4. Нажимаешь `Start full transfer by tag`.
5. ParserVo идет партиями по 5–25 товаров и переносит остатки.

Если на складе-отправителе у variant есть 3 шт, то ParserVo делает:

- склад-отправитель: 0 шт
- склад-получатель: +3 шт к текущему остатку

## Безопасная проверка

Перед настоящим переносом можно нажать:

`Preview first batch без изменения Shopify`

Это покажет первую партию, но не изменит остатки.

## Установка

Распаковать ZIP в корень проекта с заменой файлов:

`C:\Users\user\ParserVo CINQ\supplier-import-sync`

Потом:

```powershell
npm run build
git add -A
git commit -m "Add warehouse transfer by Shopify tag"
git push origin main
```

После деплоя Vercel открыть Shopify Admin → ParserVo и нажать `Ctrl + F5`.
