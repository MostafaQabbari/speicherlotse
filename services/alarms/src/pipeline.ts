import { BatchPipeline, type BaseStats, type RetryOptions } from '@speicherlotse/service-kit';
import type { AlarmEngine, BatchOutcome } from './alarm-engine.ts';

export interface AlarmStats extends BaseStats {
  samples: number;
  skippedOld: number;
  skippedInvalid: number;
  undecodable: number;
  fired: number;
  resolved: number;
}

export interface AlarmPipelineOptions {
  engine: AlarmEngine;
  maxMessages?: number;
  maxWaitMs?: number;
  retry?: Partial<RetryOptions>;
  onFatal?: (err: Error) => void;
  log?: (line: string) => void;
}

export type AlarmPipeline = BatchPipeline<AlarmStats, BatchOutcome>;

/** The generic BatchPipeline (packages/service-kit) with the alarm engine plugged in as the job. */
export function alarmPipeline(o: AlarmPipelineOptions): AlarmPipeline {
  const log = o.log ?? (() => undefined);
  return new BatchPipeline<AlarmStats, BatchOutcome>({
    stats: { messages: 0, batches: 0, retries: 0, commitErrors: 0, samples: 0, skippedOld: 0, skippedInvalid: 0, undecodable: 0, fired: 0, resolved: 0 },
    handle: (batch) => o.engine.handle(batch),
    record: (s, outcome) => {
      s.samples += outcome.samples;
      s.skippedOld += outcome.skippedOld;
      s.skippedInvalid += outcome.skippedInvalid;
      s.undecodable += outcome.undecodable;
      for (const e of outcome.events) {
        if (e.event === 'fired') s.fired++; else s.resolved++;
        log(`ALARM ${e.event.toUpperCase()} ${e.ruleId} (${e.severity}) device ${e.deviceId} at ${new Date(e.atMs).toISOString()}`);
      }
      for (const p of outcome.problems) log(`skipped: ${p}`);
    },
    ...(o.maxMessages === undefined ? {} : { maxMessages: o.maxMessages }),
    ...(o.maxWaitMs === undefined ? {} : { maxWaitMs: o.maxWaitMs }),
    ...(o.retry === undefined ? {} : { retry: o.retry }),
    ...(o.onFatal === undefined ? {} : { onFatal: o.onFatal }),
    log,
  });
}