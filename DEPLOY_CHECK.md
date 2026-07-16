# ParserVo v3 deployment

Verified locally:
- `npm ci --ignore-scripts` completes successfully (547 packages).
- React Router type generation completes.
- TypeScript reaches only PrismaClient generation; Prisma binary download is unavailable in the isolated build environment.

Vercel configuration:
- Framework is intentionally `null`; this is a React Router 7 app, not legacy Remix.
- Dependencies install through the committed `package-lock.json`.
- Prisma postinstall is skipped during install.
- `prisma generate` runs in `vercel-build`, where Vercel has network access to Prisma binaries.

Vercel Project Settings:
- Node.js: 22.x
- Framework preset: Other (or leave repository `vercel.json` in control)
- Do not override Install Command or Build Command.
