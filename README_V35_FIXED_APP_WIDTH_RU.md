# ParserVo v35 — фикс ширины админки Shopify App

Что исправлено:

1. Страница внутри Shopify iframe больше не должна свободно двигаться влево/вправо.
2. Горизонтальная прокрутка оставлена только внутри таблицы товаров.
3. Карточки, фильтры, toolbar и таблица ограничены шириной окна приложения.
4. Header и верхние кнопки теперь переносятся и не растягивают страницу.
5. Sticky-колонки таблицы сохранены: Select / Image / Title / Actions.

Установка:

```powershell
cd "C:\Users\user\ParserVo CINQ\supplier-import-sync"

npm run build
git add -A
git commit -m "Fix embedded app horizontal layout"
git push origin main
```

После деплоя Vercel открой Shopify App и нажми `Ctrl + F5`.
