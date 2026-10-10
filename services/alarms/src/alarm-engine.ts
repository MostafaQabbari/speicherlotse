import { decodeBatch } from '@speicherlotse/wire';
import type { Sample } from '@speicherlotse/telemetry-model';
import type { AlarmRule, AlarmTransition } from '@speicherlotse/alarm-rules';
import type { RawMessage } from '@speicherlotse/service-kit';
import type { Database } from './db.ts';
import { run, type DeviceRecord } from './engine.ts';
import { loadDevices, saveChanges } from './store.ts';

export interface BatchOutcome {
  messages: number;
  /** Messages that could not be decoded; they are skipped (and reported), never retried. */
  undecodable: number;
  samples: number;
  skippedOld: number;
  skippedInvalid: number;
  events: AlarmTransition[];
  problems: string[];
}

const MAX_PROBLEMS = 5;
const decoder = new TextDecoder();

/**
 * Turns Kafka messages into alarm events and stores them. One call = one batch = one database transaction.
 *
 * The engine keeps the record of every device it has seen in memory (a watermark and the non-normal alarms:
 * a few dozen bytes per device, so 10,000 devices are well below 10 MB). A device it has not seen since
 * starting is read from the database first. A failed batch changes nothing in memory, so the pipeline can run
 * the same batch again after a transient database error.
 */
export class AlarmEngine {
  readonly #db: Database;
  readonly #rules: readonly AlarmRule[];
  readonly #known = new Map<number, DeviceRecord>();

  constructor(db: Database, rules: readonly AlarmRule[]) {
    this.#db = db;
    this.#rules = rules;
  }

  /** Number of devices held in memory. */
  get devices(): number {
    return this.#known.size;
  }

  async handle(messages: readonly RawMessage[]): Promise<BatchOutcome> {
    const samples: Sample[] = [];
    const problems: string[] = [];
    let undecodable = 0;
    for (const m of messages) {
      const decoded = m.value === null ? null : decodeBatch(decoder.decode(m.value));
      if (decoded === null || !decoded.ok) {
        undecodable++;
        if (problems.length < MAX_PROBLEMS) problems.push(`${m.topic}[${m.partition}]@${m.offset}: ${decoded === null ? 'empty message' : decoded.reason}`);
        continue;
      }
      for (const s of decoded.samples) samples.push(s);
    }

    // Read the state of devices seen for the first time. This only reads, and what it reads is the truth in
    // the database, so keeping it in memory is safe even if the write below fails.
    const unseen = [...new Set(samples.map((s) => s.deviceId))].filter((id) => !this.#known.has(id));
    for (const [id, record] of await loadDevices(this.#db, unseen)) this.#known.set(id, record);

    const result = run(this.#known, samples, this.#rules);
    if (result.changed.size > 0) {
      await this.#db.transaction((tx) => saveChanges(tx, result.changed, result.events));
    }
    // Only now, with the transaction committed, does memory move forward.
    for (const [id, record] of result.changed) this.#known.set(id, record);

    return {
      messages: messages.length,
      undecodable,
      samples: samples.length,
      skippedOld: result.skippedOld,
      skippedInvalid: result.skippedInvalid,
      events: result.events,
      problems,
    };
  }
}