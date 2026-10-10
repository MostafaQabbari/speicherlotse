import { describeError, toError } from './errors.ts';
import { DEFAULT_RETRY, withRetry, type RetryOptions } from './retry.ts';

/** What a service needs to know about one Kafka message. */
export interface RawMessage {
  topic: string;
  partition: number;
  offset: bigint;
  value: Uint8Array | null;
}

/** A message from the log, plus the way to tell the log "this one is safely handled". */
export interface SourceMessage extends RawMessage {
  commit(): void | Promise<void>;
}

/** Counters every pipeline keeps. A service adds its own (rows stored, alarms fired, ...) by extending this. */
export interface BaseStats {
  messages: number;
  batches: number;
  retries: number;
  commitErrors: number;
}

export interface BatchPipelineOptions<S extends BaseStats, O> {
  /** The service's own counters. The pipeline updates the BaseStats fields; `record` updates the rest. */
  stats: S;
  /**
   * Does the real work for one batch (decode, compute, write to the database) and resolves ONLY when the result
   * is durable. It may be called again for the same batch after a transient failure, so it must be safe to repeat.
   */
  handle: (batch: readonly SourceMessage[]) => Promise<O>;
  /** Called once per successful batch, before the commit: add the outcome to the service's counters, log problems. */
  record: (stats: S, outcome: O) => void;
  /** Handle when this many messages are waiting. */
  maxMessages?: number;
  /** Handle after this long even if the batch is small, so live data is never held back for long. */
  maxWaitMs?: number;
  retry?: Partial<RetryOptions>;
  /** Called once, when the pipeline can no longer work. After that it refuses every message. */
  onFatal?: (err: Error) => void;
  log?: (line: string) => void;
}

/**
 * Collects messages into batches, hands each batch to `handle`, and ONLY THEN tells the log it is done
 * (commit). Properties this class guarantees:
 *  - A message is committed only after `handle` succeeded for its batch.
 *  - Batches are handled one at a time, in order, so a later commit never overtakes an earlier batch.
 *  - A transient failure (database outage) is waited out with backoff while the source is held back; nothing is skipped.
 *  - After an unrecoverable failure the pipeline is "failed": it refuses all further messages, because
 *    committing a later offset would silently skip the batch that failed.
 */
export class BatchPipeline<S extends BaseStats, O> {
  readonly stats: S;

  readonly #handle: BatchPipelineOptions<S, O>['handle'];
  readonly #record: BatchPipelineOptions<S, O>['record'];
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

  constructor(o: BatchPipelineOptions<S, O>) {
    this.stats = o.stats;
    this.#handle = o.handle;
    this.#record = o.record;
    this.#maxMessages = o.maxMessages ?? 200;
    this.#maxWaitMs = o.maxWaitMs ?? 1_000;
    this.#retry = { ...DEFAULT_RETRY, ...o.retry };
    this.#onFatal = o.onFatal;
    this.#log = o.log ?? (() => undefined);
  }

  /** Starts the timer that handles small batches after maxWaitMs. */
  start(): void {
    this.#timer = setInterval(() => {
      if (!this.#busy && this.#buffer.length > 0) this.flush().catch(() => undefined);   // failures already reach onFatal
    }, this.#maxWaitMs);
  }

  /** Takes one message. Resolves at once, or (when a full batch is waiting) after that batch is handled: backpressure. */
  async add(m: SourceMessage): Promise<void> {
    if (this.#failed) throw this.#failed;
    if (this.#stopping) return;   // not buffered, so never committed: the log will deliver it again
    this.#buffer.push(m);
    if (this.#buffer.length >= this.#maxMessages) await this.flush();
  }

  /** Handles everything buffered so far. Calls queue up, so batches never overlap. */
  flush(): Promise<void> {
    const run = this.#chain.then(() => this.#runBuffered());
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** Stops accepting messages, handles what is buffered, stops the timer. */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    await this.flush();
  }

  /** Gives up on waiting for a database that stays down; the batch in progress fails and stays uncommitted. */
  abort(): void {
    this.#abort.abort(new Error('shutdown requested while the database was unreachable'));
  }

  async #runBuffered(): Promise<void> {
    if (this.#failed) throw this.#failed;
    const batch = this.#buffer.splice(0);
    if (batch.length === 0) return;

    this.#busy = true;
    try {
      const outcome = await withRetry(() => this.#handle(batch), {
        ...this.#retry,
        signal: this.#abort.signal,
        onRetry: (err, attempt, delayMs) => {
          this.stats.retries++;
          this.#log(`database not ready (${describeError(err)}); attempt ${attempt} failed, trying again in ${delayMs} ms`);
          this.#retry.onRetry?.(err, attempt, delayMs);
        },
      });
      this.stats.batches++;
      this.stats.messages += batch.length;
      this.#record(this.stats, outcome);

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
        // The batch is handled, so nothing is lost: at worst the log delivers it again and the service
        // discards what it already has (duplicate rows, samples older than the watermark).
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
export async function pump(source: AsyncIterable<SourceMessage>, pipeline: Pick<BatchPipeline<BaseStats, unknown>, 'add'>): Promise<void> {
  for await (const m of source) await pipeline.add(m);
}