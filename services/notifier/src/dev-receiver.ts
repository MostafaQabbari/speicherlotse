// A tiny webhook receiver for trying the notifier on your own machine. It prints what it gets, drops duplicates
// the way a real receiver should (by the Idempotency-Key header) and can refuse requests on purpose.
//   PORT         default 8099
//   FAIL_FIRST   answer the first N requests with FAIL_STATUS instead of accepting them (default 0)
//   FAIL_STATUS  default 503 (a transient error); use 400 to see the notifier give up at once
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8099);
const FAIL_FIRST = Number(process.env.FAIL_FIRST ?? 0);
const FAIL_STATUS = Number(process.env.FAIL_STATUS ?? 503);

const seen = new Set<string>();
let requests = 0;

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    requests++;
    if (requests <= FAIL_FIRST) {
      console.log(`request ${requests}: answering ${FAIL_STATUS} on purpose`);
      res.writeHead(FAIL_STATUS).end('refused on purpose');
      return;
    }
    const id = String(req.headers['idempotency-key'] ?? '');
    let text = Buffer.concat(chunks).toString('utf8');
    try { text = (JSON.parse(text) as { text?: string }).text ?? text; } catch { /* print the raw body */ }
    if (id !== '' && seen.has(id)) {
      console.log(`DUPLICATE, ignored: ${text} [${id}]`);
    } else {
      if (id !== '') seen.add(id);
      console.log(`RECEIVED: ${text} [${id}]`);
    }
    res.writeHead(200).end('ok');
  });
}).listen(PORT, () => console.log(`receiver listening on http://localhost:${PORT} (failing the first ${FAIL_FIRST} requests with ${FAIL_STATUS})`));