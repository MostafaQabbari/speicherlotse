import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { createHome, stepHome, DEFAULT_HOME, type Sample } from '@speicherlotse/telemetry-model';
import { encodeBatch, topicFor } from '@speicherlotse/wire';
import { route, MAX_PAYLOAD_BYTES, RAW_TOPIC, REJECTED_TOPIC } from '../src/route.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const NOW = 1_791_525_725_000;

function batch(deviceId: number, n = 5): Sample[] {
  const cfg = { ...DEFAULT_HOME, deviceId };
  let state = createHome(cfg, deviceId);
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const r = stepHome(cfg, state, NOW + i * 1000, 1);
    state = r.state;
    out.push(r.sample);
  }
  return out;
}

test('a good message goes to telemetry.raw, keyed by device, payload unchanged', () => {
  const payload = encodeBatch(batch(7));
  const r = route(topicFor(7), enc(payload), NOW);
  assert.equal(r.kind, 'accepted');
  if (r.kind !== 'accepted') return;
  assert.equal(r.message.topic, RAW_TOPIC);
  assert.equal(r.message.key, '7');
  assert.equal(r.message.value, payload);
  assert.equal(r.samples, 5);
  assert.deepEqual(r.message.headers, { 'mqtt-topic': topicFor(7), 'received-at-ms': String(NOW) });
});

test('the same device always gets the same key, so it always lands in the same partition', () => {
  const keys = [1, 2, 3].map((i) => {
    const r = route(topicFor(9), enc(encodeBatch(batch(9, i))), NOW + i);
    return r.message.key;
  });
  assert.deepEqual(keys, ['9', '9', '9']);
});

test('a payload claiming another device is rejected, not stored under either id', () => {
  const r = route(topicFor(7), enc(encodeBatch(batch(8))), NOW);
  assert.equal(r.kind, 'rejected');
  if (r.kind !== 'rejected') return;
  assert.equal(r.message.topic, REJECTED_TOPIC);
  assert.match(r.reason, /does not match the topic/);
  assert.equal(r.message.key, '7');
});

test('garbage, wrong version and an empty batch are rejected with a reason and a preview', () => {
  for (const bad of ['not json', '{"v":2}', '{"v":1,"deviceId":7,"bootId":1,"samples":[]}', '']) {
    const r = route(topicFor(7), enc(bad), NOW);
    assert.equal(r.kind, 'rejected', bad);
    const info = JSON.parse(r.message.value);
    assert.equal(info.reason, r.kind === 'rejected' ? r.reason : '');
    assert.equal(info.mqttTopic, topicFor(7));
    assert.equal(info.receivedAtMs, NOW);
    assert.equal(info.preview, bad);
  }
});

test('a topic that is not ours is rejected and has no key', () => {
  for (const topic of ['', 'other/1/telemetry', 'speicherlotse/v1/devices/0/telemetry']) {
    const r = route(topic, enc(encodeBatch(batch(1))), NOW);
    assert.equal(r.kind, 'rejected', topic);
    assert.equal(r.message.key, null);
    assert.equal(r.message.topic, REJECTED_TOPIC);
  }
});

test('an oversized payload is rejected before parsing, and the preview stays short', () => {
  const big = new Uint8Array(MAX_PAYLOAD_BYTES + 1).fill(65);
  const r = route(topicFor(1), big, NOW);
  assert.equal(r.kind, 'rejected');
  if (r.kind !== 'rejected') return;
  assert.equal(r.reason, 'payload too large');
  assert.ok(r.message.value.length < 1_000);
});

test('route never throws, whatever the topic and bytes are', () => {
  fc.assert(fc.property(fc.string(), fc.uint8Array({ maxLength: 2_000 }), (topic, bytes) => {
    const r = route(topic, bytes, NOW);
    assert.ok(r.kind === 'accepted' || r.kind === 'rejected');
  }), { numRuns: 300 });
});

test('whatever is accepted came from a valid topic and a matching payload', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 100_000 }), (topicId, payloadId) => {
    const r = route(topicFor(topicId), enc(encodeBatch(batch(payloadId, 1))), NOW);
    assert.equal(r.kind === 'accepted', topicId === payloadId);
  }), { numRuns: 100 });
});