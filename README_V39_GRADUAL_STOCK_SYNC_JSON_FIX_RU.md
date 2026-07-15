# ParserVo v39 — fix gradual stock sync JSON/DOCTYPE error

Исправляет ошибку:

```text
Unexpected token '<', "<!DOCTYPE "... is not valid JSON
```

Причина: фронтенд отправлял постепенную синхронизацию stock на страницу `/app/products`, а в некоторых случаях Shopify/React Router/Vercel возвращали HTML-документ вместо JSON.

Что изменено:

1. Добавлен отдельный API endpoint:
   - `app/routes/api.gradual-stock-sync-batch.tsx`
   - URL: `/api/gradual-stock-sync-batch`
2. Кнопка `Start gradual stock sync ALL` теперь обращается к этому API endpoint.
3. Ответ всегда возвращается как `application/json`.
4. Если сервер всё равно вернул HTML, приложение показывает понятную ошибку с подсказкой, а не `Unexpected token '<'`.
5. v36 не использовался. Фикс сделан поверх рабочей ветки с постепенной stock sync и админкой.

После установки:

```powershell
npm run build
git add -A
git commit -m "Fix gradual stock sync JSON endpoint"
git push origin main
```

После деплоя:

1. Открой ParserVo из Shopify Admin.
2. Нажми `Ctrl + F5`.
3. Проверь, что endpoint доступен: `/api/gradual-stock-sync-batch` должен возвращать JSON.
4. Запусти `Start gradual stock sync ALL` с batch size 5.
