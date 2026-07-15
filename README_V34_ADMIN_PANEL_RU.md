# ParserVo v34 — удобная админ-панель Imported Products

Что изменено:

1. Страница Imported Products теперь растянута на всю ширину Shopify App iframe.
2. Добавлена удобная панель фильтров:
   - Search
   - Shopify: all / created / not created / duplicates / duplicate copies
   - Status
   - Stock
   - Sync
   - Size mode: with sizes / no size UNI / sold out
   - Type
   - filter_name
   - Color
   - Target gender
   - Audit: duplicates / missing color / missing price / missing image / supplier sold out
3. Добавлена массовая панель действий:
   - Select filtered
   - Select not-created
   - Select duplicate copies
   - Select sold out
   - Clear selection
   - Create selected Draft
   - Create selected Active
   - Enable sync
   - Disable sync
   - Sync category meta
   - Delete selected
4. Таблица стала удобнее:
   - sticky header
   - sticky Select / Image / Title
   - sticky Actions справа
   - компактные кнопки в строках
   - подсветка дублей
   - показ duplicate group / duplicate copy
5. Старые массовые действия перенесены в Advanced batch creation, чтобы не мешали ежедневной работе.

Как поставить:

```powershell
cd "C:\Users\user\ParserVo CINQ\supplier-import-sync"

npm run build
git add -A
git commit -m "Improve imported products admin table filters and bulk actions"
git push origin main
```

После деплоя Vercel открой ParserVo → Imported Products и обнови страницу Ctrl+F5.
