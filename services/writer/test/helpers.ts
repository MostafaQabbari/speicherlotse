import { encodeBatch } from '@speicherlotse/wire';
import type { Sample } from '@speicherlotse/telemetry-model';
import type { Queryable } from '../src/insert.ts';
import type { SourceMessage } from '../src/pipeline.ts';

export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const encoder = new TextEncoder();

export function sample(deviceId: number, seq: number): Sample {
  return { deviceId, bootId: 1, seq, wallMs: T0 + seq * 1000, monoMs: seq * 1000, values: { pvW: 100 + seq } };
}

/** A Kafka message holding `count` samples of one device, starting at sequence number `firstSeq`. */
export function message(
  partition: number, offset: number, deviceId: number, firstSeq: number, count: number, log: string[] = [],
): SourceMessage {
  const samples = Array.from({ length: count }, (_, i) => sample(deviceId, firstSeq + i));
  return {
    topic: 'telemetry.raw',
    partition,
    offset: BigInt(offset),
    value: encoder.encode(encodeBatch(samples)),
    commit: () => { log.push(`commit p${partition}@${offset}`); },
  };
}

export function raw(partition: number, offset: number, value: string | null, log: string[] = []): SourceMessage {
  return {
    topic: 'telemetry.raw', partition, offset: BigInt(offset),
    value: value === null ? null : encoder.encode(value),
    commit: () => { log.push(`commit p${partition}@${offset}`); },
  };
}

export interface FakeDb extends Queryable {
  inserts: number;
  rows: number;
  maxConcurrent: number;
}

/** A database that records what it is asked and can be told to fail. `fail(n)` runs before every query. */
export function fakeDb(log: string[], fail: (callNumber: number) => Error | null = () => null): FakeDb {
  let calls = 0;
  let running = 0;
  const db: FakeDb = {
    inserts: 0,
    rows: 0,
    maxConcurrent: 0,
    async query(_text, values) {
      calls++;
      running++;
      db.maxConcurrent = Math.max(db.maxConcurrent, running);
      try {
        await new Promise((r) => setTimeout(r, 2));   // time for overlapping calls to show up
        const err = fail(calls);
        if (err) throw err;
        const n = (values?.[0] as unknown[]).length;
        db.inserts++;
        db.rows += n;
        log.push(`insert ${n} rows`);
        return { rowCount: n };
      } finally {
        running--;
      }
    },
  };
  return db;
}

export function codeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}