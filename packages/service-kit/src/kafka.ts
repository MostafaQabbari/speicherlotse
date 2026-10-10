import { Consumer } from '@platformatic/kafka';
import type { SourceMessage } from './batch-pipeline.ts';

export interface KafkaSource {
  messages: AsyncIterable<SourceMessage>;
  close(): Promise<void>;
}

/**
 * Joins the consumer group and returns the messages of one topic.
 *  - autocommit is OFF: offsets are committed by the pipeline, after the batch is handled (stored).
 *  - mode 'committed': continue where this group stopped. fallbackMode 'earliest': a group that never
 *    committed anything starts at the beginning of the topic. (The library default is "latest", which
 *    would skip every message that is already in the topic when the writer starts for the first time.)
 */
export async function openKafkaSource(o: { brokers: string[]; groupId: string; topic: string; clientId: string }): Promise<KafkaSource> {
  const consumer = new Consumer({
    clientId: o.clientId,
    groupId: o.groupId,
    bootstrapBrokers: o.brokers,
  });
  const stream = await consumer.consume({
    topics: [o.topic],
    mode: 'committed',
    fallbackMode: 'earliest',
    autocommit: false,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });
  return {
    messages: stream,
    async close() {
      await stream.close();
      await consumer.close();
    },
  };
}