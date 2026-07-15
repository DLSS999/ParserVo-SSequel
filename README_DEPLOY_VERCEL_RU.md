# ParserVo v25 — Vercel + Supabase deploy

Эта версия подготовлена для онлайн-запуска без домена: GitHub → Vercel → Supabase PostgreSQL → Shopify Custom distribution.

## Важные env variables для Vercel

- SHOPIFY_API_KEY
- SHOPIFY_API_SECRET
- SHOPIFY_APP_URL
- DATABASE_URL
- SCOPES
- NODE_ENV=production

## Build command

```bash
npm run build
```

Build выполняет Prisma generate + db push + React Router build.
