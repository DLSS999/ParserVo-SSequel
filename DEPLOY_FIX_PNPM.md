# Vercel dependency installation fix

This version intentionally uses pnpm instead of npm because Vercel npm installation was failing before the project build with `Exit handler never called`.

Vercel commands:

- Install: `corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --no-frozen-lockfile`
- Build: `pnpm run vercel-build`
- Node.js: `22.x`
- Framework preset: `Other`

`package-lock.json` is intentionally removed so Vercel does not auto-select npm.
