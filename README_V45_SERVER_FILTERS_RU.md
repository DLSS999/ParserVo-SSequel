# ParserVo v45 — server-side filters for Imported Products

Исправление фильтров на странице Imported Products.

## Что исправлено

- Фильтры теперь работают не только по 50 товарам текущей страницы, а по всей базе ParserVo.
- Можно выбрать Stock → `Продан / нет у поставщика` и сразу получить товары со статусом `supplier_sold_out`.
- Добавлена быстрая кнопка `Show sold out`.
- Search применяется через Enter или кнопку `Apply filters`.
- Select filtered выделяет только товары, которые видны на текущей странице, чтобы случайно не удалить товары со всех страниц.
- Пагинация сохраняет выбранные фильтры при переходе Next / Prev / Last.
- В ZIP сохранены изменения v44, v43, v42 и Stock Sync Center.

## Как пользоваться

1. Открой ParserVo → Imported Products.
2. Чтобы показать проданные товары, нажми `Show sold out` или выбери Stock → `Продан / нет у поставщика`.
3. Перейди по страницам Next / Prev, если таких товаров больше 50.
4. Нажми `Select filtered`, если нужно выделить видимые товары на текущей странице.
5. Затем можно удалить выбранные через `Delete selected`.

## Установка

Распакуй ZIP с заменой файлов в проект:

```powershell
cd "C:\Users\user\ParserVo CINQ\supplier-import-sync"

npm run build
git add -A
git commit -m "Fix imported products server filters with pagination"
git push origin main
```

После деплоя Vercel открой приложение и нажми Ctrl + F5.
