# Supplier Import Sync — Shopify App MVP

Это стартовый MVP Shopify-приложения для импорта товаров поставщиков и будущей синхронизации наличия.

## Что уже есть

- Shopify embedded app structure
- React Router app
- Shopify OAuth через официальный Shopify app package
- Prisma + SQLite для dev
- Dashboard
- Import Product
- Imported Products
- Sync Logs
- Settings
- Проверка дублей по supplier_url и supplier_product_id
- MVP-заготовка Vitkac parser для тестовой ссылки
- Сохранение товара, размеров, поставщика и статусов в базу приложения

## Что подключаем следующим шагом

- Реальный парсинг Vitkac через Playwright
- Перенос всех фото товара
- Перенос Symbol, COLOR, цены, размеров, описания и характеристик
- Создание Shopify product через Admin GraphQL API
- Создание variants по размерам
- Запись Shopify product ID / variant IDs в базу
- Sync наличия и перевод Active/Draft

## Важно по Node.js

Нужен Node.js:

```txt
>=20.19 <22 или >=22.12
```

Проверить:

```powershell
node -v
```

Если у тебя стоит Node 20.18.1, нужно переключиться на 20.19.5 или выше.

## Как запустить

Открой PowerShell в папке проекта и выполни:

```powershell
npm install
npm run setup
shopify app dev
```

Или запусти файл:

```powershell
.\01_INSTALL_AND_RUN_DEV.ps1
```

Если PowerShell не дает запускать `.ps1`, используй `.bat`:

```powershell
.\01_INSTALL_AND_RUN_DEV.bat
```

## При первом запуске

Shopify CLI попросит:

1. Войти в Shopify Partner account.
2. Выбрать organization.
3. Создать или выбрать app.
4. Выбрать dev store.
5. Установить app в dev store.

После запуска нажми:

```txt
p
```

Откроется preview приложения.

## Тестовая ссылка Vitkac

```txt
https://www.vitkac.com/pl/p/heeled-shoes-spino-marsell-shoes-1836330
```

На этой версии parser пока возвращает тестовые данные для этой логики:

- Supplier: Vitkac
- Symbol: MW8730 P041-666
- Color: BLACK / Чорний
- Brand: Marsell
- Sizes: 36, 37, 38, 38.5, 39, 39.5, 40, 41
- Size 40 = sold out
- Остальные размеры = available

## Структура проекта

```txt
app/
  routes/
    app.tsx
    app._index.tsx
    app.import.tsx
    app.products.tsx
    app.logs.tsx
    app.settings.tsx
  services/
    pricing.server.ts
    vitkac.server.ts
    status.ts
  db.server.ts
  shopify.server.ts
  root.tsx
  styles.css
prisma/
  schema.prisma
shopify.app.toml
shopify.web.toml
package.json
```

## Если будет ошибка Prisma table does not exist

Выполни:

```powershell
npm run setup
```

или:

```powershell
npx prisma generate
npx prisma db push
```

## Если Shopify CLI просит scopes заново

Это нормально, потому что приложению нужны права:

```txt
read_products, write_products, read_inventory, write_inventory, read_locations
```

Подтверди установку заново в dev store.

## Текущий статус

Это MVP 1. Он нужен, чтобы мы подключили приложение к dev store и начали дальше спокойно добавлять реальный parser и Shopify product creation.
