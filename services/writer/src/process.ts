import { decodeBatch } from '@speicherlotse/wire';
import type { Sample } from '@speicherlotse/telemetry-model';
import { insertRows, type Queryable } from './insert.ts';
import { toRows } from './rows.ts';

/** What the writer needs to know about one Kafka message. */
export interface RawMessage {
  topic: string;
  partition: number;
  offset: bigint;
  value: Uint8Array | null;
}

export interface BatchOutcome {
  messages: number;
  /** Messages that could not be decoded; they are skipped (and reported), never retried. */
  undecodable: number;
  samples: number;
  /** Samples that could not be stored (clock outside 2000..2100, id out of range, ...). */
  rejectedSamples: number;
  inserted: number;
  /** Rows that were already in the table: redelivered messages, replays. */
  duplicates: number;
  /** The first few reasons, for the log. */
  problems: string[];
}

const MAX_PROBLEMS = 5;
const decoder = new TextDecoder();

/**
 * Decodes the messages, turns the samples into rows and inserts them in ONE call. Resolves only when the
 * rows are in the database; throws if the database fails (the caller decides whether to retry).
 *
 * Messages that cannot be decoded are skipped, not thrown: ingest has already validated everything on
 * telemetry.raw, so this should not happen, and if it does, retrying the same bytes would block the
 * partition forever.
 */
export async function storeMessages(db: Queryable, messages: readonly RawMessage[]): Promise<BatchOutcome> {
  const samples: Sample[] = [];
  const problems: string[] = [];
  let undecodable = 0;

  const note = (m: RawMessage, why: string): void => {
    undecodable++;
    if (problems.length < MAX_PROBLEMS) problems.push(`${m.topic}[${m.partition}]@${m.offset}: ${why}`);
  };

  for (const m of messages) {
    if (m.value === null) { note(m, 'empty message'); continue; }
    const decoded = decodeBatch(decoder.decode(m.value));
    if (!decoded.ok) { note(m, decoded.reason); continue; }
    for (const s of decoded.samples) samples.push(s);
  }

  const { rows, rejected } = toRows(samples);
  for (const r of rejected) {
    if (problems.length < MAX_PROBLEMS) problems.push(`device ${r.sample.deviceId} seq ${r.sample.seq}: ${r.reason}`);
  }
  const inserted = await insertRows(db, rows);

  return {
    messages: messages.length,
    undecodable,
    samples: samples.length,
    rejectedSamples: rejected.length,
    inserted,
    duplicates: rows.length - inserted,
    problems,
  };
}