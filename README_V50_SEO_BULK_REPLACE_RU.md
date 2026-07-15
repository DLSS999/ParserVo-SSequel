# ParserVo v50 — SEO Bulk Replace / Brand Normalization

Добавлена массовая замена текстовых блоков в SEO Center.

## Что добавлено

Страница:

```text
ParserVo → SEO Center → Group replace / normalization
```

Можно заменить группы текста, например:

```text
Ami Alexandre Mattiussi → Ami Paris
```

## Какие блоки можно менять

- ParserVo brand
- Shopify vendor
- Shopify SEO title
- Shopify meta description
- ParserVo title
- ParserVo original title
- Shopify product title

## Как пользоваться

1. Открой `SEO Center`.
2. При необходимости выбери фильтр `Brand = Ami Alexandre Mattiussi` или `Search = Ami`.
3. В блоке `Group replace / normalization` укажи:

```text
Найти текст: Ami Alexandre Mattiussi
Заменить на: Ami Paris
```

4. Нажми `Preview first batch`.
5. Проверь список.
6. Нажми `Apply replace to batch`.

Обработка ограничена до 50 товаров за запуск, чтобы не ловить лимиты Shopify и 504.

## Установка

```powershell
cd "C:\Users\user\ParserVo CINQ\supplier-import-sync"

npm run build
git add -A
git commit -m "Add SEO bulk replace and brand normalization"
git push origin main
```

После деплоя Vercel открой Shopify Admin → ParserVo и нажми `Ctrl + F5`.
