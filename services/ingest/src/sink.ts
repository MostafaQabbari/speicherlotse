import { Producer, stringSerializers } from '@platformatic/kafka';
import type { OutMessage } from './route.ts';

/** Where accepted and rejected messages go. Kafka in production, the console for a dry run. */
export interface Sink {
  send(m: OutMessage): Promise<void>;
  close(): Promise<void>;
}

export function kafkaSink(brokers: string[]): Sink {
  const producer = new Producer({
    clientId: 'speicherlotse-ingest',
    bootstrapBrokers: brokers,
    serializers: stringSerializers,
  });
  return {
    async send(m) {
      // acks: -1 = wait until all in-sync replicas have the message. send() only returns after that,
      // and the MQTT acknowledgement is sent only after send() returns (see main.ts).
      await producer.send({
        acks: -1,
        messages: [{ topic: m.topic, ...(m.key === null ? {} : { key: m.key }), value: m.value, headers: m.headers }],
      });
    },
    async close() {
      await producer.close();
    },
  };
}

export function consoleSink(): Sink {
  return {
    async send(m) {
      console.log(`[dry run] ${m.topic} key=${m.key ?? '-'} ${m.value.length} bytes`);
    },
    async close() {},
  };
}