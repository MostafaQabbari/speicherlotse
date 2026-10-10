import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseState } from '../src/store.ts';

test('parseState reads the four states back', () => {
  assert.deepEqual(parseState({ kind: 'normal' }), { kind: 'normal' });
  assert.deepEqual(parseState({ kind: 'pending', sinceMs: 5 }), { kind: 'pending', sinceMs: 5 });
  assert.deepEqual(parseState({ kind: 'firing', sinceMs: 5 }), { kind: 'firing', sinceMs: 5 });
  assert.deepEqual(parseState({ kind: 'clearing', sinceMs: 9, firedMs: 5 }), { kind: 'clearing', sinceMs: 9, firedMs: 5 });
});

test('parseState refuses anything else instead of guessing', () => {
  for (const bad of [null, 'firing', 7, [], {}, { kind: 'firing' }, { kind: 'firing', sinceMs: 'x' }, { kind: 'clearing', sinceMs: 1 }, { kind: 'broken', sinceMs: 1 }]) {
    assert.throws(() => parseState(bad), /not an alarm state/);
  }
});