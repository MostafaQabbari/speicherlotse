import { describeError } from '@speicherlotse/service-kit';
import type { NotificationMessage } from './message.ts';

/**
 * A failed delivery. `permanent` means that trying again cannot help (the receiver refused the message itself,
 * for example 400 or 404); otherwise waiting may help (network down, receiver overloaded or restarting).
 */
export class SendError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SendError';
    this.permanent = permanent;
  }
}

/** Delivers one message. It resolves when the receiver has taken the message over, and throws a SendError otherwise. */
export interface Sender {
  readonly name: string;
  send(message: NotificationMessage): Promise<void>;
}

/** Prints the message. The default when no webhook is configured, and what you want while developing. */
export const logSender = (log: (line: string) => void): Sender => ({
  name: 'log',
  async send(m) {
    log(`NOTIFY ${m.text}`);
  },
});

export interface WebhookOptions {
  url: string;
  timeoutMs: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

/** HTTP statuses where waiting can help: timeout, too early, too many requests, and every server error. */
const isTransientStatus = (status: number): boolean => status >= 500 || status === 408 || status === 425 || status === 429;

/**
 * POSTs the message as JSON. The header `Idempotency-Key` carries the message id: a receiver that remembers the
 * keys it has seen can ignore the duplicates this program may send (see ADR-005).
 * Redirects are not followed: a POST that is redirected is a wrong address, not something to retry.
 */
export function webhookSender(o: WebhookOptions): Sender {
  const doFetch = o.fetch ?? fetch;
  return {
    name: 'webhook',
    async send(m) {
      let res: Response;
      try {
        res = await doFetch(o.url, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/json', 'idempotency-key': m.id },
          body: JSON.stringify(m),
          signal: AbortSignal.timeout(o.timeoutMs),
        });
      } catch (err) {
        // No answer at all: connection refused, DNS failure, reset, or the timeout. All may pass.
        throw new SendError(`webhook not reachable: ${describeError(err)}`, false, { cause: err });
      }
      const body = (await res.text().catch(() => '')).slice(0, 200);
      if (res.ok) return;
      throw new SendError(`webhook answered ${res.status}${body ? `: ${body}` : ''}`, !isTransientStatus(res.status));
    },
  };
}