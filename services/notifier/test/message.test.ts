import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, notificationId, type OutboxRow } from '../src/message.ts';

const row: OutboxRow = { deviceId: 2, ruleId: 'battery-temp-critical', event: 'fired', severity: 'critical', atMs: Date.UTC(2026, 9, 10, 14, 3, 53, 609), attempts: 0 };

test('the id is the alarm event key written as text, and the same for every attempt', () => {
  assert.equal(notificationId(row), `2:battery-temp-critical:${row.atMs}:fired`);
  assert.equal(buildMessage({ ...row, attempts: 5 }).id, buildMessage(row).id);
});

test('two different alarm events never share an id', () => {
  const ids = [
    notificationId(row),
    notificationId({ ...row, event: 'resolved' }),
    notificationId({ ...row, deviceId: 3 }),
    notificationId({ ...row, ruleId: 'battery-temp-high' }),
    notificationId({ ...row, atMs: row.atMs + 1 }),
  ];
  assert.equal(new Set(ids).size, ids.length);
});

test('the message carries the event time in ISO 8601 and reads like the alarm engine log line', () => {
  const m = buildMessage(row);
  assert.equal(m.at, '2026-10-10T14:03:53.609Z');
  assert.equal(m.text, 'ALARM FIRED battery-temp-critical (critical) device 2 at 2026-10-10T14:03:53.609Z');
  assert.equal(buildMessage({ ...row, event: 'resolved' }).text, 'ALARM RESOLVED battery-temp-critical (critical) device 2 at 2026-10-10T14:03:53.609Z');
});