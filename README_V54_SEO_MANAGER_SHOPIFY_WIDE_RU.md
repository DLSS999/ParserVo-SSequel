# ParserVo v54 — SEO Manager для всех товаров Shopify

## Что добавлено

1. SEO format для ВСЕХ товаров Shopify
   - работает со всеми товарами магазина, даже если они не были загружены через ParserVo;
   - можно оставить Shopify search query пустым для обработки всех товаров;
   - можно использовать собственные шаблоны SEO title и meta description;
   - есть Preview SEO example;
   - есть Start automatic SEO update партиями по 10 / 20 / 50 товаров.

2. Vendor / Type для ВСЕХ товаров Shopify
   - отдельный блок только для Vendor, Shopify product type/category и замены текста в product title;
   - SEO не трогает;
   - работает со всеми товарами Shopify по search query или по всему магазину.

3. SEO format для ParserVo товаров
   - отдельный блок для товаров, связанных с ParserVo;
   - поддерживает переменные color, SKU, price, nameType;
   - работает по текущим фильтрам SEO Center.

4. ParserVo Vendor / Brand normalization
   - оставлен как отдельный блок для товаров ParserVo.

## Переменные для Shopify-wide SEO

- `{vendor}` — текущий Vendor товара или Vendor override
- `{brand}` — то же самое, что vendor
- `{title}` — product title
- `{type}` — Shopify product type
- `{productType}` — Shopify product type
- `{handle}` — handle товара
- `{status}` — статус товара
- `{store}` — CINQ

## Переменные для ParserVo SEO

- `{brand}`
- `{vendor}`
- `{title}`
- `{type}`
- `{nameType}`
- `{color}`
- `{sku}`
- `{price}`
- `{store}`

## Как использовать для всех товаров магазина

1. Открой ParserVo → SEO Center.
2. В блоке `SEO format для ВСЕХ товаров Shopify` оставь Shopify search query пустым или укажи фильтр, например:
   - `vendor:'Ami Alexandre Mattiussi'`
   - `tag:PreOrder`
   - `Ami`
3. Укажи формат SEO title и description.
4. Нажми `Preview SEO example`.
5. Если пример правильный — нажми `Start automatic SEO update`.

## Как заменить Vendor Ami Alexandre Mattiussi → Ami Paris во всем Shopify

1. В блоке `Vendor / Type для ВСЕХ товаров Shopify` поставь:
   - Shopify search query: `vendor:'Ami Alexandre Mattiussi'`
   - Новый Shopify Vendor: `Ami Paris`
2. Нажми `Preview fields batch`.
3. Нажми `Start automatic Vendor / Type update`.

