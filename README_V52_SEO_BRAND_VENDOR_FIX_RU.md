# ParserVo v52 — SEO Brand Vendor Fix

Что исправлено:

1. Добавлен отдельный блок SEO Center → Brand normalization: Vendor + SEO.
2. Это не обычная текстовая замена. Блок принудительно ставит Shopify Vendor в указанное значение.
3. Можно одновременно обновить:
   - ParserVo brand
   - Shopify vendor
   - Generated Shopify SEO title/meta description
4. Добавлена автоматическая обработка партиями по 10/20/50 товаров.
5. Если в v50 ParserVo brand уже изменился на Ami Paris, но Shopify Vendor остался Ami Alexandre Mattiussi — выбери Brand = Ami Paris и запусти Brand normalization только для Shopify vendor + Regenerate SEO.

Как использовать для AMI:

1. Открой ParserVo → SEO Center.
2. Если товары еще имеют старый бренд в ParserVo:
   - Brand filter: Ami Alexandre Mattiussi
   - Старый бренд: Ami Alexandre Mattiussi
   - Новый бренд: Ami Paris
   - включить ParserVo brand, Shopify vendor, Regenerate SEO
3. Если после v50 в ParserVo уже Ami Paris, но Shopify Vendor старый:
   - Brand filter: Ami Paris
   - Новый бренд: Ami Paris
   - можно оставить старый бренд как есть, фильтр важнее
   - включить Shopify vendor и Regenerate SEO
4. Нажать Preview brand batch.
5. Нажать Start automatic brand normalization.

Важно:

- Обычный Group replace оставлен для точечной текстовой замены.
- Для брендов лучше использовать новый блок Brand normalization: Vendor + SEO.
- Автоматическая обработка идет, пока открыта страница SEO Center.
