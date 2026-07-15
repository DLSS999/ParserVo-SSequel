# ParserVo v49 — SEO Center

Добавлена новая админ-страница для настройки SEO товаров, которые уже созданы в Shopify.

## Новая страница

Shopify Admin → ParserVo → SEO Center

## Что умеет

- показывает товары, которые уже связаны с Shopify;
- подтягивает текущие SEO title / meta description из Shopify;
- генерирует SEO title и meta description по данным ParserVo: бренд, модель, тип, цвет, SKU, цена;
- показывает длину title и description;
- позволяет массово обновить SEO выбранных товаров;
- позволяет обновить SEO текущей страницы;
- позволяет вручную отредактировать SEO title и meta description конкретного товара;
- пишет результат в Sync Logs.

## Массовые действия

- Select page — выбрать товары на текущей странице;
- Update selected generated SEO — обновить SEO только выбранных товаров;
- Update current page SEO — обновить SEO всех товаров на текущей странице;
- Update next 20 filtered — обновить следующие 20 товаров по текущему фильтру.

## Безопасность

За один запрос обновляется максимум 50 товаров, чтобы не ловить 504 и лимиты Shopify.

## Установка

```powershell
cd "C:\Users\user\ParserVo CINQ\supplier-import-sync"

npm run build
git add -A
git commit -m "Add SEO Center for Shopify products"
git push origin main
```

После деплоя открой ParserVo через Shopify Admin и нажми Ctrl + F5.
