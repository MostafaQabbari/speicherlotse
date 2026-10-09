import { connect } from 'mqtt';
import { TELEMETRY_FILTER } from '@speicherlotse/wire';
import { route } from './route.ts';
import type { Sink } from './sink.ts';

export interface IngestOptions {
  mqttUrl: string;
  sink: Sink;
  /** A fixed client id plus a persistent session lets the broker keep unacknowledged messages while we are down. */
  clientId?: string;
  now?: () => number;
  /** Called once if the sink fails. The message that failed has NOT been acknowledged, so the broker will redeliver it. */
  onFatal?: (error: unknown) => void;
}

export interface Stats { accepted: number; rejected: number; samples: number }

export interface RunningIngest {
  stats: Stats;
  stop(): Promise<void>;
}

export async function startIngest(o: IngestOptions): Promise<RunningIngest> {
  const now = o.now ?? Date.now;
    // connect() returns the client at once, before the network connection exists. That matters: a broker that
  // resumes a saved session sends the waiting messages in the same breath as its CONNACK, so the handler below
  // must already be in place. (With connectAsync the handler was installed a moment too late, and the library's
  // default handler acknowledged those first messages without storing them.)
  const client = connect(o.mqttUrl, { clientId: o.clientId ?? 'speicherlotse-ingest', clean: false });
  const stats: Stats = { accepted: 0, rejected: 0, samples: 0 };
  let inFlight: Promise<void> = Promise.resolve();
  let failed = false;

  // mqtt.js sends the QoS 1 acknowledgement (PUBACK) only when this callback completes without an error.
  // So we call `done()` only after the sink (Kafka) has the message. If the sink fails we never call it:
  // the broker keeps the message and delivers it again after we reconnect. That is "at least once".
  // The client also hands us one message at a time, which keeps the order per device.
  client.handleMessage = (packet, done) => {
    if (failed) return;
    const payload = typeof packet.payload === 'string' ? new TextEncoder().encode(packet.payload) : packet.payload;
    const routed = route(packet.topic, payload, now());
    inFlight = o.sink.send(routed.message).then(
      () => {
        if (routed.kind === 'accepted') { stats.accepted++; stats.samples += routed.samples; } else { stats.rejected++; }
        done();
      },
      (error: unknown) => {
        failed = true;
        client.end(true);          // drop the connection without acknowledging anything
        o.onFatal?.(error);
      },
    );
  };

    await new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => { client.off('connect', onConnect); client.end(true); reject(e); };
    const onConnect = () => { client.off('error', onError); resolve(); };
    client.once('connect', onConnect);
    client.once('error', onError);
  });

  await client.subscribeAsync(TELEMETRY_FILTER, { qos: 1 });

  return {
    stats,
    async stop() {
      await inFlight;
      if (!failed) await client.endAsync();
    },
  };
}