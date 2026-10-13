# Dashboard

An Angular web page for one tenant: connect with a token, pick a device, see its latest values, one channel over time, and its alarm events.

It only reads. It talks to the API (`services/api`) and nothing else.

## Run it

Three terminals, Windows PowerShell, from the repository root. The services (Docker, migrations, seed) are started as described in the main README.

```powershell
# 1. the API, allowed to be called from this page
$env:JWT_SECRET = "<the same secret you use everywhere>"
$env:CORS_ORIGINS = "http://localhost:4200"
pnpm --filter @speicherlotse/api start

# 2. a token (same secret), printed so that you can paste it into the page
$env:JWT_SECRET = "<the same secret>"
node services/api/src/token-cli.ts alpha

# 3. the dashboard
cd apps/dashboard
pnpm start          # http://localhost:4200
```

Open <http://localhost:4200> (not `127.0.0.1:4200`: that is a different origin and the API refuses it), paste the token, press Connect.

## What is in it

| | |
|---|---|
| API client | Generated from `services/api/openapi.json` by `ng-openapi-gen` into `src/app/api/` (not committed; `pnpm run generate`, which start, build, test and typecheck run first). A change in the API's description therefore changes the types here, and the compiler shows what broke |
| Forms | Reactive Forms: the connection form (address and token shape) and the from / to / rows filter, checked with the same limits the API enforces |
| Token | Kept in memory only (no localStorage, cookie or URL); sent only to the API address |
| Chart | Drawn by hand as SVG (`chart-geometry.ts` is the tested maths). It has a text description, and the same numbers are one click away as a table |
| Accessibility | Labels, a skip link, keyboard use, live regions for results and errors, status shown by text and symbol (not colour alone), light and dark colours, narrow screens. The unit tests run axe-core over the page (colour contrast cannot be checked without a real browser and was looked at by eye) |
| Tests | `pnpm test`: maths of the chart, error messages, the store (requests, stale answers, token handling), the forms, and the whole page with axe |

Not done: Storybook, automated browser tests (the page was driven by hand in Chromium against the real API), refresh by itself, a real sign-in.

## Why this folder has its own TypeScript

Angular 22 requires TypeScript 6.0; the rest of the repository uses TypeScript 7. In a pnpm workspace each package keeps its own version, so both live side by side. The root `pnpm typecheck` and `pnpm test` do not look into `apps/`; Nx runs the dashboard's own targets:

```powershell
pnpm exec nx run-many -t typecheck test build -p @speicherlotse/dashboard --parallel=1
```
