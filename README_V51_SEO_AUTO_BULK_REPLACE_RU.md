# ParserVo v51 — SEO automatic bulk replace

Добавлена автоматическая групповая замена в SEO Center.

## Что изменено

На странице `ParserVo → SEO Center` в блоке `Group replace / normalization` теперь есть кнопки:

- `Preview first batch` — проверка первой партии без изменений.
- `Apply one batch` — ручная обработка одной партии.
- `Start automatic replace` — автоматическая обработка всех товаров по текущим фильтрам партиями по 10/20/50.
- `Stop automatic replace` — остановка процесса.

## Пример

Для замены бренда:

`Ami Alexandre Mattiussi → Ami Paris`

1. В SEO Center выбери фильтр Brand = `Ami Alexandre Mattiussi` или Search = `Ami`.
2. В блоке Group replace укажи:
   - Найти текст: `Ami Alexandre Mattiussi`
   - Заменить на: `Ami Paris`
3. Выбери поля для замены:
   - ParserVo brand
   - Shopify vendor
   - Shopify SEO title
   - Shopify meta description
4. Поставь лимит партии 10 или 20.
5. Нажми `Start automatic replace`.

## Важно

Автоматическая замена работает пока открыта страница SEO Center. Это безопаснее для Shopify лимитов: товары обновляются маленькими партиями, а не одним огромным запросом.
