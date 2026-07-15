# Fix v5 — Vitkac HTTP 403 / browser parser

В этой версии исправлена ошибка импорта:

```
Vitkac parser error: Vitkac returned HTTP 403
```

Причина: Vitkac блокирует обычный server-side fetch. Теперь парсер сначала пробует обычный HTML-запрос, а если получает 403, запускает локальный Chromium через Playwright и читает страницу как браузер.

## Как обновить

1. Останови приложение: `q` или `Ctrl+C`.
2. Скопируй файлы из архива поверх текущей папки проекта.
3. В PowerShell внутри проекта выполни:

```powershell
npm install
npx playwright install chromium
npx prisma db push
npx prisma generate
shopify app dev
```

Если PowerShell блокирует `.ps1`, используй `.bat` или команды вручную.

## Важно

Теперь приложение не должно падать красным Application Error при ошибке парсинга. Если Vitkac снова заблокирует страницу, ошибка будет показана внутри страницы Import Product.
