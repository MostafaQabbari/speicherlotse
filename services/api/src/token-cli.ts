import { signDevToken } from './auth.ts';
import { DEMO_TENANTS } from './demo.ts';
import { isTenantId } from './tenant-db.ts';

// node services/api/src/token-cli.ts <alpha | beta | tenant-uuid> [hours]
// Prints only the token, so that it can be stored in a variable.
const [who, hoursRaw] = process.argv.slice(2);
const secret = process.env.JWT_SECRET ?? '';
const hours = hoursRaw === undefined ? 12 : Number(hoursRaw);

const demo = DEMO_TENANTS.find((t) => t.key === who);
const tenantId = demo?.id ?? who;
if (!isTenantId(tenantId) || !(hours > 0 && hours <= 24 * 30)) {
  console.error('usage: node services/api/src/token-cli.ts <alpha | beta | tenant-uuid> [hours, default 12, at most 720]');
  process.exit(1);
}
console.log(await signDevToken({ secret, tenantId, subject: `dev-${who}`, ttlSeconds: Math.round(hours * 3_600) }));
