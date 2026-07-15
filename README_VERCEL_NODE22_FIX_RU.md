# Исправление деплоя Vercel

Исправлена ошибка установки зависимостей:

`npm error Exit handler never called!`

Причина: Vercel использовал Node.js 24, а проект содержал pnpm-настройку `shamefully-hoist` в `.npmrc`.

Изменения:
- Node.js зафиксирован на `22.x`;
- npm зафиксирован через `packageManager: npm@10.9.4`;
- удалён `shamefully-hoist`;
- Vercel использует `npm ci --no-audit --no-fund`;
- добавлен `vercel.json`;
- package-lock синхронизирован.

После загрузки в GitHub Vercel должен начать новый деплой. В настройках Vercel Node.js Version также рекомендуется установить `22.x`.
