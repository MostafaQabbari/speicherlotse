// Which database errors are worth waiting for, and how long to wait.

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH',
]);

// PostgreSQL SQLSTATE classes that clear up by themselves:
//   08 connection exception, 40 transaction rollback (deadlock), 53 insufficient resources,
//   57 operator intervention (server shutting down, "cannot connect now"), 58 system error.
// Everything else (22 bad data, 23 constraint, 42 syntax or missing table, ...) is a bug or a wrong setup:
// waiting will not help, so the caller must stop and tell a human.
const TRANSIENT_SQLSTATE = /^(08|40|53|57|58)/;

const TRANSIENT_MESSAGE = /connection terminated|connection error|timeout exceeded|client was closed|server closed the connection/i;

export function isTransient(err: unknown): boolean {
  if (err instanceof AggregateError) return err.errors.some(isTransient);   // Node reports "localhost" as several attempts
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (TRANSIENT_NODE_CODES.has(code) || TRANSIENT_SQLSTATE.test(code))) return true;
  return err instanceof Error && TRANSIENT_MESSAGE.test(err.message);
}

export interface RetryOptions {
  baseMs: number;
  maxMs: number;
  isRetryable: (err: unknown) => boolean;
  /** Aborting stops the waiting and makes withRetry throw (used for shutdown). */
  signal?: AbortSignal;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export const DEFAULT_RETRY: RetryOptions = { baseMs: 500, maxMs: 30_000, isRetryable: isTransient };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs fn; while it fails with a retryable error, waits (exponential backoff with jitter, capped at maxMs)
 * and tries again, with no limit on the number of attempts: a database outage should delay the writer,
 * not kill it. A non-retryable error is thrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (o.signal?.aborted || !o.isRetryable(err)) throw err;
      const delay = Math.round(Math.min(o.maxMs, o.baseMs * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
      o.onRetry?.(err, attempt, delay);
      await sleep(delay, o.signal);
    }
  }
}