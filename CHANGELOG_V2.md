# ParserVo v2 — изменения

- Добавлен общий контракт `MarketplaceParser`.
- Добавлен runner с контролем параллельности и журналом ошибок.
- Добавлен отдельный Stone Island Sale crawler.
- Существующий YNAP crawler сохранён без замены.
- Worker заменён с заглушки на BullMQ-исполнитель Stone Island jobs.
- Добавлены отдельные команды `crawl:stone-island`, `crawl:ynap`, `typecheck`.
- Добавлена безопасная конфигурация `.env.example`.
- Из финального архива удалены `.env`, `prisma/dev.db`, `node_modules`.

## Ограничение проверки
В среде сборки установка npm-зависимостей не завершилась из-за тайм-аута, поэтому финальную runtime-проверку Playwright следует выполнить локально командой из README.
