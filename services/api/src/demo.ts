// The two demo tenants that `pnpm --filter @speicherlotse/api seed` creates. Fixed ids, so that commands in the README
// and tokens stay valid after a reset. Devices 1 to 3 are what the publisher simulates by default (SYSTEMS=3).
export const DEMO_TENANTS = [
  { key: 'alpha', id: '11111111-1111-4111-8111-111111111111', name: 'Demo Tenant Alpha', devices: [1, 2] },
  { key: 'beta',  id: '22222222-2222-4222-8222-222222222222', name: 'Demo Tenant Beta',  devices: [3] },
] as const;
