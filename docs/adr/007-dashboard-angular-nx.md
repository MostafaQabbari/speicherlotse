# ADR-007: Dashboard with Angular in an Nx workspace

Status: proposed (nothing of the dashboard is built yet; this records the decision before the work starts)

## Context

The API (ADR-006) is finished and described by `services/api/openapi.json`. The project needs a dashboard to show devices, telemetry and alarm events for one tenant.

The author wants to learn and show a stack that German employers frequently ask for: Angular, Nx, Reactive Forms, a client generated from an API description, Storybook, and accessibility testing.

## Decision

- The dashboard is an Angular app at `apps/dashboard`.
- Nx manages it and sits next to the existing pnpm workspace (`packages/*`, `services/*`). The dashboard has its own `tsconfig`, because the repository root uses TypeScript 7 and Node-specific compiler options that an Angular build does not share.
- The API client is generated from `services/api/openapi.json`, not written by hand. The committed file is checked against the code by a test, so the generated client cannot drift from the real API unnoticed.
- Filters and the token field use Reactive Forms.
- Components are documented in Storybook.
- Accessibility is checked in Storybook (addon-a11y) and in an automated axe run; keyboard use and labels are part of the definition of done for each component.
- The browser can call the API only if its origin is listed in `CORS_ORIGINS` (ADR-006 / Step 7). Local development uses `http://localhost:4200`.

## Alternatives

- React with Vite: smaller and faster to start, but it does not practise the stack named above.
- No dashboard: the API and the curl examples would remain the only way to see the data.

## Consequences

- Two toolchains in one repository (pnpm scripts and Nx targets). CI must run both.
- Dev tokens are pasted into the dashboard by hand; this is acceptable only because the tokens are development tokens. Real sign-in is a separate decision.
- Until the dashboard exists, the CV and README must not say it was built.