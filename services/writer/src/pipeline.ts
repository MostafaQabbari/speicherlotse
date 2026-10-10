import { BatchPipeline, type BaseStats, type RetryOptions, type SourceMessage } from '@speicherlotse/service-kit';
import type { Queryable } from './insert.ts';
import { storeMessages, type BatchOutcome } from './process.ts';

export type { SourceMessage };

export interface WriterStats extends BaseStats {
  samples: number;
  inserted: number;
  duplicates: number;
  rejectedSamples: number;
  undecodable: number;
}

export interface WriterPipelineOptions {
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

export type Pipeline = BatchPipeline<WriterStats, BatchOutcome>;

/**
 * The writer is the generic BatchPipeline (batching, ordering, retry, commit after the work is durable, see
 * packages/service-kit) with one job plugged in: decode the messages and insert the rows.
 */
export function writerPipeline(o: WriterPipelineOptions): Pipeline {
  const log = o.log ?? (() => undefined);
  return new BatchPipeline<WriterStats, BatchOutcome>({
    stats: { messages: 0, batches: 0, retries: 0, commitErrors: 0, samples: 0, inserted: 0, duplicates: 0, rejectedSamples: 0, undecodable: 0 },
    handle: (batch) => storeMessages(o.db, batch),
    record: (s, outcome) => {
      s.samples += outcome.samples;
      s.inserted += outcome.inserted;
      s.duplicates += outcome.duplicates;
      s.rejectedSamples += outcome.rejectedSamples;
      s.undecodable += outcome.undecodable;
      for (const p of outcome.problems) log(`skipped: ${p}`);
    },
    ...(o.maxMessages === undefined ? {} : { maxMessages: o.maxMessages }),
    ...(o.maxWaitMs === undefined ? {} : { maxWaitMs: o.maxWaitMs }),
    ...(o.retry === undefined ? {} : { retry: o.retry }),
    ...(o.onFatal === undefined ? {} : { onFatal: o.onFatal }),
    log,
  });
}