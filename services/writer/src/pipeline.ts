import type { Queryable } from './insert.ts';
import { storeMessages, type RawMessage } from './process.ts';
import { DEFAULT_RETRY, withRetry, type RetryOptions } from './retry.ts';

/** A message from the log, plus the way to tell the log "this one is safely stored". */
export interface SourceMessage extends RawMessage {
  commit(): void | Promise<void>;
}

export interface PipelineStats {
  messages: number;
  samples: number;
  inserted: number;
  duplicates: number;
  rejectedSamples: number;
  undecodable: number;
  batches: number;
  retries: number;
  commitErrors: number;
}

export interface PipelineOptions {
  db: Queryable;
  /** Write when this many messages are waiting. 200 messages of 5 samples = 1,000 rows (ADR-001). */
  maxMessages?: number;
  /** Write after this long even if the batch is small, so live data is never held back for long. */
  maxWaitMs?: number;
  retry?: Partial<RetryOptions>;
  /** Called once, when the pipeline can no longer write. After that it refuses every message. */
  onFatal?: (err: Error) => void;
  log?: (line: string) => void;
}

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

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

/**
 * Collects messages into batches, writes each batch to the database, and ONLY THEN tells the log it is
 * stored (commit). Properties this class guarantees:
 *  - A message is committed only after its rows are in the database (or were already there).
 *  - Batches are written one at a time, in order, so a later commit never overtakes an earlier batch.
 *  - A database outage is waited out (backoff) while the source is held back; nothing is skipped.
 *  - After an unrecoverable failure the pipeline is "failed": it refuses all further messages, because
 *    committing a later offset would silently skip the batch that failed.
 */
export class Pipeline {
  readonly stats: PipelineStats = {
    messages: 0, samples: 0, inserted: 0, duplicates: 0, rejectedSamples: 0, undecodable: 0, batches: 0, retries: 0, commitErrors: 0,
  };

  readonly #db: Queryable;
  readonly #maxMessages: number;
  readonly #maxWaitMs: number;
  readonly #retry: RetryOptions;
  readonly #onFatal: ((err: Error) => void) | undefined;
  readonly #log: (line: string) => void;
  readonly #abort = new AbortController();

  #buffer: SourceMessage[] = [];
  #chain: Promise<void> = Promise.resolve();
  #busy = false;
  #stopping = false;
  #failed: Error | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(o: PipelineOptions) {
    this.#db = o.db;
    this.#maxMessages = o.maxMessages ?? 200;
    this.#maxWaitMs = o.maxWaitMs ?? 1_000;
    this.#retry = { ...DEFAULT_RETRY, ...o.retry };
    this.#onFatal = o.onFatal;
    this.#log = o.log ?? (() => undefined);
  }

  /** Starts the timer that writes small batches after maxWaitMs. */
  start(): void {
    this.#timer = setInterval(() => {
      if (!this.#busy && this.#buffer.length > 0) this.flush().catch(() => undefined);   // failures already reach onFatal
    }, this.#maxWaitMs);
  }

  /** Takes one message. Resolves at once, or (when a full batch is waiting) after that batch is stored: backpressure. */
  async add(m: SourceMessage): Promise<void> {
    if (this.#failed) throw this.#failed;
    if (this.#stopping) return;   // not buffered, so never committed: the log will deliver it again
    this.#buffer.push(m);
    if (this.#buffer.length >= this.#maxMessages) await this.flush();
  }

  /** Writes everything buffered so far. Calls queue up, so batches never overlap. */
  flush(): Promise<void> {
    const run = this.#chain.then(() => this.#writeBuffered());
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** Stops accepting messages, writes what is buffered, stops the timer. */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    await this.flush();
  }

  /** Gives up on waiting for a database that stays down; the batch in progress fails and stays uncommitted. */
  abort(): void {
    this.#abort.abort(new Error('shutdown requested while the database was unreachable'));
  }

  async #writeBuffered(): Promise<void> {
    if (this.#failed) throw this.#failed;
    const batch = this.#buffer.splice(0);
    if (batch.length === 0) return;

    this.#busy = true;
    try {
      const outcome = await withRetry(() => storeMessages(this.#db, batch), {
        ...this.#retry,
        signal: this.#abort.signal,
        onRetry: (err, attempt, delayMs) => {
          this.stats.retries++;
          this.#log(`database not ready (${describeError(err)}); attempt ${attempt} failed, trying again in ${delayMs} ms`);
          this.#retry.onRetry?.(err, attempt, delayMs);
        },
      });
      const s = this.stats;
      s.batches++;
      s.messages += outcome.messages;
      s.samples += outcome.samples;
      s.inserted += outcome.inserted;
      s.duplicates += outcome.duplicates;
      s.rejectedSamples += outcome.rejectedSamples;
      s.undecodable += outcome.undecodable;
      for (const p of outcome.problems) this.#log(`skipped: ${p}`);

      await this.#commit(batch);
    } catch (err) {
      this.#fail(toError(err));
      throw this.#failed;
    } finally {
      this.#busy = false;
    }
  }

  /** Commits the highest offset of each partition in the batch (a commit covers everything before it). */
  async #commit(batch: readonly SourceMessage[]): Promise<void> {
    const last = new Map<string, SourceMessage>();
    for (const m of batch) {
      const key = `${m.topic}/${m.partition}`;
      const prev = last.get(key);
      if (prev === undefined || m.offset > prev.offset) last.set(key, m);
    }
    for (const m of last.values()) {
      try {
        await m.commit();
      } catch (err) {
        // The rows are stored, so nothing is lost: at worst the log delivers this batch again and the
        // primary key discards the duplicates.
        this.stats.commitErrors++;
        this.#log(`commit of ${m.topic}[${m.partition}] offset ${m.offset} failed (${describeError(err)}); the batch may be read again`);
      }
    }
  }

  #fail(err: Error): void {
    if (this.#failed !== null) return;
    this.#failed = err;
    this.#onFatal?.(err);
  }
}

/** Feeds every message of the source into the pipeline. Ends when the source ends or the pipeline fails. */
export async function pump(source: AsyncIterable<SourceMessage>, pipeline: Pipeline): Promise<void> {
  for await (const m of source) await pipeline.add(m);
}