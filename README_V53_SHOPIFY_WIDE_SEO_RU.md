# ParserVo v53 — Shopify-wide SEO + удобный интерфейс SEO Center

## Что исправлено

1. SEO Center больше не фиксируется по высоте окна как таблица Imported Products.
   Страница нормально скроллится, блоки не должны уезжать и обрезаться.

2. Добавлен новый блок:
   **Shopify-wide SEO / Vendor**

   Он работает со всеми товарами Shopify, даже если товар не был загружен через ParserVo.

3. Для задач типа:
   `Ami Alexandre Mattiussi → Ami Paris`

   можно массово обновлять:
   - Shopify Vendor
   - Shopify SEO title
   - Shopify meta description
   - Shopify product title, если включить отдельно

4. Обновление работает автоматически партиями по 10 / 20 / 50 товаров.

## Как пользоваться

1. Открой ParserVo → SEO Center.
2. В блоке **Shopify-wide SEO / Vendor** укажи:
   - Shopify search query: `Ami Alexandre Mattiussi`
   - Старый текст: `Ami Alexandre Mattiussi`
   - Новый бренд: `Ami Paris`
3. Оставь включенными:
   - Shopify Vendor
   - Regenerate SEO
4. Сначала нажми **Preview Shopify batch**.
5. Если список правильный, нажми **Start automatic Shopify-wide update**.

## Важно

Блок **Brand normalization: Vendor + SEO** ниже работает только с товарами из базы ParserVo.

Для всех товаров магазина используй только верхний блок:
**Shopify-wide SEO / Vendor**.
