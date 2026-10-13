// The page sizes of the list routes. One place, because the routes (parseLimit) and the OpenAPI description
// (openapi.ts) must say the same numbers, and a test (openapi.test.ts) holds them to it.

export const TELEMETRY_LIMIT = { default: 100, max: 1_000 } as const;
export const ALARM_EVENTS_LIMIT = { default: 50, max: 500 } as const;
