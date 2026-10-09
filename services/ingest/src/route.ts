import { decodeBatch, parseTopic } from '@speicherlotse/wire';

/** Kafka topic for batches that passed validation. */
export const RAW_TOPIC = 'telemetry.raw';
/** Kafka topic for messages we refused, with the reason. Nothing is silently dropped. */
export const REJECTED_TOPIC = 'telemetry.rejected';

/** An MQTT message larger than this is refused without even parsing it. 100 samples are about 20 KB. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** How much of a refused payload we keep for debugging. */
const PREVIEW_CHARS = 512;

export interface OutMessage {
  topic: string;
  key: string | null;     // Kafka picks the partition from the key; the same key always lands in the same partition
  value: string;
  headers: Record<string, string>;
}

export type Routed =
  | { kind: 'accepted'; message: OutMessage; samples: number }
  | { kind: 'rejected'; message: OutMessage; reason: string };

/**
 * Pure decision: what should happen to one MQTT message? No clock, no network, so it is easy to test.
 *
 *  accepted -> telemetry.raw, key = deviceId, value = the original bytes exactly as received
 *  rejected -> telemetry.rejected, value = {reason, mqttTopic, receivedAtMs, preview}
 *
 * The raw log keeps what the device really sent. Whoever reads it later decodes it again with the same
 * decoder, so a change to decoding rules can be replayed over old data.
 */
export function route(mqttTopic: string, payload: Uint8Array, receivedAtMs: number): Routed {
  const headers = { 'mqtt-topic': mqttTopic, 'received-at-ms': String(receivedAtMs) };
  const reject = (reason: string, key: string | null): Routed => ({
    kind: 'rejected',
    reason,
    message: {
      topic: REJECTED_TOPIC,
      key,
      value: JSON.stringify({ reason, mqttTopic, receivedAtMs, preview: preview(payload) }),
      headers,
    },
  });

  const t = parseTopic(mqttTopic);
  if (t === null) return reject('unexpected MQTT topic', null);
  const key = String(t.deviceId);

  if (payload.byteLength > MAX_PAYLOAD_BYTES) return reject('payload too large', key);

  const text = new TextDecoder('utf-8').decode(payload);
  const decoded = decodeBatch(text);
  if (!decoded.ok) return reject(decoded.reason, key);

  // The topic says who is talking, the payload says who the data belongs to. If they differ, one of them
  // is wrong or forged, and storing the data under either id would corrupt another device's history.
  const claimed = decoded.samples[0]?.deviceId;
  if (claimed !== t.deviceId) return reject('deviceId in payload does not match the topic', key);

  return { kind: 'accepted', samples: decoded.samples.length, message: { topic: RAW_TOPIC, key, value: text, headers } };
}

function preview(payload: Uint8Array): string {
  return new TextDecoder('utf-8').decode(payload.subarray(0, PREVIEW_CHARS));
}