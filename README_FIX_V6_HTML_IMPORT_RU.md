# Fix v6 — HTML import mode для Vitkac

Vitkac может отдавать HTTP 403 для Node.js/Playwright-парсера, хотя страница открывается в обычном Chrome.

В этой версии добавлен HTML import mode:

1. Открой товар Vitkac в Chrome.
2. Нажми Ctrl+U.
3. Нажми Ctrl+A.
4. Нажми Ctrl+C.
5. Вернись в Shopify App → Import Product.
6. Вставь ссылку товара в Supplier product URL.
7. Открой блок HTML import mode.
8. Вставь HTML в Vitkac page HTML.
9. Нажми Parse product.

Так приложение парсит HTML, который уже открылся у тебя в браузере, и не получает 403 от Vitkac.
