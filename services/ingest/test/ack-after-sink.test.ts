import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import mqttPacket from 'mqtt-packet';
import { createHome, stepHome, DEFAULT_HOME } from '@speicherlotse/telemetry-model';
import { encodeBatch, topicFor } from '@speicherlotse/wire';
import { startIngest } from '../src/ingest.ts';
import type { OutMessage } from '../src/route.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function payloadFor(deviceId: number): Buffer {
  const cfg = { ...DEFAULT_HOME, deviceId };
  const sample = stepHome(cfg, createHome(cfg, deviceId), 1_791_525_725_000, 1).sample;
  return Buffer.from(encodeBatch([sample]));
}

/**
 * A minimal fake MQTT broker that behaves like Mosquitto resuming a saved session: the moment it says
 * CONNACK it also pushes the messages that were waiting for the client, in the SAME network write.
 * It records, in order, every PUBACK it receives.
 */
function fakeBroker(waiting: number[]) {
  const pubacks: number[] = [];
  const server = net.createServer((socket) => {
    const parser = mqttPacket.parser();
    parser.on('packet', (p) => {
      if (p.cmd === 'connect') {
        const parts = [mqttPacket.generate({ cmd: 'connack', returnCode: 0, sessionPresent: true })];
        for (const id of waiting) {
          parts.push(mqttPacket.generate({
            cmd: 'publish', topic: topicFor(id), payload: payloadFor(id), qos: 1, messageId: id, dup: true, retain: false,
          }));
        }
        socket.write(Buffer.concat(parts));
      } else if (p.cmd === 'subscribe') {
        socket.write(mqttPacket.generate({ cmd: 'suback', messageId: p.messageId, granted: [1] }));
      } else if (p.cmd === 'puback') {
        pubacks.push(p.messageId as number);
      } else if (p.cmd === 'pingreq') {
        socket.write(mqttPacket.generate({ cmd: 'pingresp' }));
      }
    });
    socket.on('data', (d) => parser.parse(d));
    socket.on('error', () => {});
  });
  return { server, pubacks };
}

test('messages resent right after CONNACK are stored before they are acknowledged', async () => {
  const waiting = [1, 2, 3];
  const { server, pubacks } = fakeBroker(waiting);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;

  const events: string[] = [];
  const stored: string[] = [];
  const sink = {
    async send(m: OutMessage) { await sleep(30); stored.push(m.key ?? '-'); events.push(`stored:${m.key}`); },
    async close() {},
  };

  const ingest = await startIngest({ mqttUrl: `mqtt://127.0.0.1:${port}`, sink, clientId: 'test-ingest' });
  for (let i = 0; i < 100 && pubacks.length < waiting.length; i++) await sleep(20);
  await ingest.stop();
  server.close();

  assert.deepEqual(stored.sort(), ['1', '2', '3'], 'every waiting message must reach the sink');
  assert.deepEqual(pubacks.slice().sort(), [1, 2, 3], 'every waiting message must be acknowledged');
});