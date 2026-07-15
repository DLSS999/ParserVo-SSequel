# ParserVo v46 — Imported Products filters embedded session fix

Исправления:

1. Фильтры Imported Products больше не сбрасывают Shopify embedded session.
   При переходе сохраняются служебные параметры Shopify (`shop`, `host`, `id_token` и другие), поэтому вместо страницы `Log in` должна открываться отфильтрованная таблица.

2. Фильтры применяются сервером по всей базе, а не только по 50 товарам текущей страницы.

3. Таблица больше не делает повторную клиентскую фильтрацию 50 загруженных строк. Это убирает ситуации, когда сервер нашел товары, но интерфейс потом скрывал их повторной проверкой.

4. Select/Filters теперь безопаснее:
   - выбрал значения в фильтрах;
   - нажал `Apply filters`;
   - для проданных товаров можно нажать `Show sold out`.

5. POST-действия на странице сохраняют текущий URL и фильтры.

Как проверить:

1. Открой ParserVo из Shopify Admin.
2. Нажми Ctrl+F5.
3. Imported Products → Show sold out.
4. Должны показаться только товары со `supplier_sold_out`, без перехода на Log in.

Установка:

```powershell
cd "C:\Users\user\ParserVo CINQ\supplier-import-sync"

npm run build
git add -A
git commit -m "Fix imported products filters preserving Shopify embedded session"
git push origin main
```
