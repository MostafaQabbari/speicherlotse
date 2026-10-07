import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS, CHANNEL_NAMES, isPlausible } from '../src/channels.ts';

test('channel ids are unique positive integers', () => {
  const ids = CHANNEL_NAMES.map((n) => CHANNELS[n].id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => Number.isInteger(id) && id > 0));
});

test('every channel has min below max', () => {
  for (const name of CHANNEL_NAMES) {
    const c = CHANNELS[name];
    assert.ok(c.min < c.max, `${name}: min must be below max`);
  }
});

test('isPlausible accepts normal values and rejects impossible ones', () => {
  assert.equal(isPlausible('battSoc', 62.5), true);
  assert.equal(isPlausible('battW', -3000), true);
  assert.equal(isPlausible('battSoc', 120), false);
  assert.equal(isPlausible('gridHz', Number.NaN), false);
});
