import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry } from './telemetry.js';

test('recordVoiceEvent maps type -> status and sets lastEventAt', () => {
  let t = 1000;
  const tel = createTelemetry(() => t);
  tel.recordVoiceEvent({ type: 'listening' });
  assert.equal(tel.voiceSnapshot().status, 'listening');
  assert.equal(tel.voiceSnapshot().lastEventAt, 1000);
  tel.recordVoiceEvent({ type: 'awake', score: 0.7 });
  assert.equal(tel.voiceSnapshot().status, 'awake');
  tel.recordVoiceEvent({ type: 'recording' });
  assert.equal(tel.voiceSnapshot().status, 'recording');
  tel.recordVoiceEvent({ type: 'transcript', text: 'turn off the tubelight' });
  const s = tel.voiceSnapshot();
  assert.equal(s.status, 'transcribing');
  assert.equal(s.lastTranscript, 'turn off the tubelight');
});

test('wake_score updates score/threshold without changing status', () => {
  const tel = createTelemetry();
  tel.recordVoiceEvent({ type: 'listening' });
  tel.recordVoiceEvent({ type: 'wake_score', score: 0.42, threshold: 0.5 });
  const s = tel.voiceSnapshot();
  assert.equal(s.status, 'listening');
  assert.equal(s.wakeScore, 0.42);
  assert.equal(s.threshold, 0.5);
});

test('voiceSnapshot reports ageMs from now', () => {
  let t = 1000;
  const tel = createTelemetry(() => t);
  tel.recordVoiceEvent({ type: 'listening' });
  t = 1750;
  assert.equal(tel.voiceSnapshot().ageMs, 750);
});

test('events and commands are newest-first and bounded to 50', () => {
  const tel = createTelemetry();
  for (let i = 0; i < 60; i++) tel.recordVoiceEvent({ type: 'wake_score', score: i / 100 });
  assert.equal(tel.voiceSnapshot().events.length, 50);
  for (let i = 0; i < 55; i++) tel.recordCommand({ text: `cmd ${i}`, ok: true });
  const cmds = tel.recentCommands();
  assert.equal(cmds.length, 50);
  assert.equal(cmds[0].text, 'cmd 54');
});

test('recordCommand stores fields + ts', () => {
  const tel = createTelemetry(() => 5000);
  tel.recordCommand({ text: 'soket on', intent: { domain: 'switch', action: 'on', target: 'socket' }, via: 'gemini', ok: true, speak: 'Socket is on.' });
  assert.deepEqual(tel.recentCommands()[0], {
    text: 'soket on', intent: { domain: 'switch', action: 'on', target: 'socket' },
    via: 'gemini', ok: true, speak: 'Socket is on.', ts: 5000,
  });
});
