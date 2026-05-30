import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchConfirm } from './confirm.js';

test('canonical confirmation phrases match', () => {
  for (const t of ['confirm', 'go ahead', 'do it', 'confirmed', 'yes confirm', 'Confirm.', 'jarvis, confirm']) {
    assert.deepEqual(matchConfirm(t), { domain: 'confirm', action: 'yes' }, t);
  }
});

test('non-confirmation text is null', () => {
  for (const t of ['', null, 'yes', 'okay', 'sure', 'maybe', 'lights off', 'open chrome']) {
    assert.equal(matchConfirm(t), null, String(t));
  }
});
