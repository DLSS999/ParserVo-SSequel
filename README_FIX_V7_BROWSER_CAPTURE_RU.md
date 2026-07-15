# FIX v7 — Browser Capture Mode для Vitkac

Vitkac блокирует автоматические запросы Node.js / Playwright и возвращает HTTP 403 / bot / access denied. Это не ошибка Shopify-приложения. Для большого количества товаров добавлен новый режим: Chrome extension берет HTML из твоего обычного Chrome, где товар уже открыт человеком, и отправляет его в приложение.

## Что добавлено

1. Новая папка `chrome-extension`.
2. Новый API endpoint приложения: `/api/vitkac-capture`.
3. Новый token в Settings / Import Product: `Browser capture token`.
4. Extension умеет:
   - импортировать текущую открытую вкладку Vitkac;
   - импортировать все открытые вкладки Vitkac товаров;
   - отправлять HTML страницы в приложение;
   - сохранять товар в Imported Products.

## Как обновить проект

Остановить приложение:

```powershell
q
```

или:

```powershell
Ctrl + C
```

Потом выполнить:

```powershell
npm install
npx prisma db push
npx prisma generate
shopify app dev
```

## Как установить Chrome extension

1. Открой Chrome.
2. Перейди на:

```txt
chrome://extensions/
```

3. Включи Developer mode.
4. Нажми Load unpacked.
5. Выбери папку:

```txt
supplier-import-sync\chrome-extension
```

## Как настроить extension

В Shopify App зайди в Import Product или Settings. Там появятся:

```txt
Shop
Browser capture token
```

В PowerShell после запуска `shopify app dev` найди строку:

```txt
Local: http://localhost:51220
```

Порт может быть другим.

В extension заполни:

```txt
Local API Base URL: http://localhost:51220
Shop: parservo.myshopify.com
Browser capture token: скопируй из приложения
PLN → UAH: актуальный курс
EUR → UAH: актуальный курс
```

Нажми Save settings.

## Как импортировать товар

1. Открой товар Vitkac в обычной вкладке Chrome.
2. Нажми extension ParserVo Vitkac Capture.
3. Нажми Capture current Vitkac product.
4. Товар появится в Imported Products.

## Как импортировать много товаров

1. Открой несколько товаров Vitkac в отдельных вкладках Chrome.
2. Нажми extension.
3. Нажми Capture all open Vitkac tabs.
4. Extension по очереди отправит все открытые товары в приложение.

## Важно

Этот режим не ломает защиту Vitkac и не пытается обходить CAPTCHA. Он работает с HTML страницы, которую ты уже видишь в обычном Chrome. Если Vitkac не отдает страницу даже в обычном Chrome, extension тоже не сможет ее импортировать.
