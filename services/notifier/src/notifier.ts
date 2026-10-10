import { describeError } from '@speicherlotse/service-kit';
import { retryDelayMs } from './backoff.ts';
import type { Db } from './db.ts';
import { buildMessage, type OutboxRow } from './message.ts';
import { SendError, type Sender } from './sender.ts';
import { due, markGaveUp, markRetry, markSent } from './store.ts';

export interface NotifierOptions {
  /** How many notifications one run takes from the outbox. */
  batchSize: number;
  /** After this many failed attempts a notification is abandoned. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injected in tests. */
  now?: () => number;
  random?: () => number;
  log?: (line: string) => void;
}

export interface RunResult {
  /** How many notifications were due at the start of this run. */
  due: number;
  sent: number;
  /** Failed, will be tried again later. */
  retried: number;
  gaveUp: number;
}

/**
 * Sends the alarm events waiting in the outbox, one after the other, oldest first.
 *
 * Delivery is AT LEAST ONCE. A notification is marked as sent only after the receiver accepted it, so a crash
 * between "accepted" and "marked" sends it a second time after the restart. Every attempt carries the same id
 * (the Idempotency-Key header of the webhook), so a receiver can drop the second copy.
 */
export class Notifier {
  readonly stats = { sent: 0, retried: 0, gaveUp: 0 };
  readonly #db: Db;
  readonly #sender: Sender;
  readonly #o: NotifierOptions;

  constructor(db: Db, sender: Sender, options: NotifierOptions) {
    this.#db = db;
    this.#sender = sender;
    this.#o = options;
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /**
   * One pass over the notifications that are due. Delivery problems never escape: they are written to the row
   * (a retry time, or "gave up"). A database error does escape; the caller waits and runs again, and whatever
   * was not marked is simply due again.
   */
  async runOnce(): Promise<RunResult> {
    const rows = await due(this.#db, this.#now(), this.#o.batchSize);
    const result: RunResult = { due: rows.length, sent: 0, retried: 0, gaveUp: 0 };

    for (const row of rows) {
      const message = buildMessage(row);
      try {
        await this.#sender.send(message);
      } catch (err) {
        await this.#failed(row, err, result);
        continue;   // one bad notification must not hold back the ones behind it
      }
      await markSent(this.#db, row);   // if this fails the row stays due: it is sent again (at least once)
      result.sent++;
      this.stats.sent++;
    }
    return result;
  }

  async #failed(row: OutboxRow, err: unknown, result: RunResult): Promise<void> {
    const reason = describeError(err);
    const failures = row.attempts + 1;
    const permanent = err instanceof SendError && err.permanent;

    if (permanent || failures >= this.#o.maxAttempts) {
      await markGaveUp(this.#db, row, reason);
      result.gaveUp++;
      this.stats.gaveUp++;
      const why = permanent ? 'the receiver refused it' : `${failures} attempts failed`;
      this.#o.log?.(`NOTIFICATION GAVE UP ${buildMessage(row).id}: ${why} (${reason})`);
      return;
    }
    const delay = retryDelayMs(failures, this.#o.baseDelayMs, this.#o.maxDelayMs, this.#o.random);
    await markRetry(this.#db, row, reason, this.#now() + delay);
    result.retried++;
    this.stats.retried++;
    this.#o.log?.(`notification ${buildMessage(row).id} failed (${reason}); attempt ${failures + 1} in ${Math.round(delay / 1000)} s`);
  }
}