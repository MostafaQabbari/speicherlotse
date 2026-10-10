export const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * A readable one-line reason for a log. Node reports "could not connect to localhost" as an AggregateError
 * (it tries ::1 and 127.0.0.1) whose own message is EMPTY, so we also look at the error code and at the
 * first inner error.
 */
export const describeError = (e: unknown): string => {
  const err = toError(e);
  const inner = err instanceof AggregateError ? toError(err.errors[0]) : undefined;
  const code = (err as { code?: unknown }).code ?? (inner as { code?: unknown } | undefined)?.code;
  const text = err.message || inner?.message || err.name;
  return typeof code === 'string' && !text.includes(code) ? `${code}: ${text}` : text;
};