# ParserVo v55 — SEO variables: SKU + custom.name_type

Добавлено в SEO Center для блока **SEO format для ВСЕХ товаров Shopify**.

## Что исправлено

1. Блок SEO для всех товаров Shopify теперь может использовать данные не только из Shopify title/vendor/type, но и из:
   - первого варианта товара: `sku`, `price`
   - Shopify product metafield: `custom.name_type`
   - Shopify product metafield: `custom.filter_name`
   - Shopify product metafield: `custom.color`
   - Shopify product metafield: `custom.product_variant`

2. Для всех Shopify-товаров добавлены переменные:
   - `{vendor}`
   - `{brand}`
   - `{title}`
   - `{name}`
   - `{sku}`
   - `{price}`
   - `{nameType}`
   - `{name_type}`
   - `{filterName}`
   - `{filter_name}`
   - `{color}`
   - `{productVariant}`
   - `{product_variant}`
   - `{type}`
   - `{productType}`
   - `{handle}`
   - `{status}`
   - `{store}`

3. В блок **Vendor / Type / Name type для ВСЕХ товаров Shopify** добавлено поле:
   - `Новый Name type / custom.name_type`

Это поле записывает значение в Shopify metafield:

```text
custom.name_type
```

## Пример SEO title format

```text
{vendor} {nameType} {sku} — купити в Україні | CINQ
```

## Пример Meta description format

```text
Оригінальний {vendor} {nameType} {sku} у CINQ. Актуальна наявність, допомога з розміром і доставка по Україні.
```

## Как обновить custom.name_type для всех Shopify товаров по фильтру

1. Открой SEO Center.
2. В блоке `Vendor / Type / Name type для ВСЕХ товаров Shopify` укажи Shopify search query.
3. В поле `Новый Name type / custom.name_type` впиши, например:
   - `Футболка`
   - `Сумка на плече`
   - `Кросівки`
4. Нажми `Preview fields batch`.
5. Потом `Start automatic Vendor / Type update`.

## Как использовать name_type в SEO

1. Открой блок `SEO format для ВСЕХ товаров Shopify`.
2. В SEO title format используй:

```text
{vendor} {nameType} {sku} — купити в Україні | CINQ
```

3. Нажми `Preview SEO example`.
4. Если пример правильный — `Start automatic SEO update`.

## Установка

```powershell
cd "C:\Users\user\ParserVo CINQ\supplier-import-sync"

npm run build
git add -A
git commit -m "Add Shopify-wide SEO variables for sku and name type"
git push origin main
```

После деплоя Vercel открой Shopify Admin → ParserVo → Ctrl + F5.
