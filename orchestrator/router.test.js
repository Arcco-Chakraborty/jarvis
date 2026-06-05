import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRegistry } from './db/registry.js';
import { route } from './router.js';

function reg() {
  return openRegistry({ dbPath: ':memory:', esp32BaseUrl: 'http://test' });
}

function fakeBoard({ states = {}, throwOnSet = false } = {}) {
  return {
    calls: [],
    allOffCalled: false,
    async set(name, on) {
      if (throwOnSet) throw new Error('unreachable');
      this.calls.push([name, on]);
    },
    async allOff() {
      this.allOffCalled = true;
    },
    isOn(name) {
      return states[name];
    },
  };
}

test('device off calls set(false) and speaks', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'off', target: 'tubelight' }, { board, registry });
  assert.deepEqual(board.calls, [['tubelight', false]]);
  assert.deepEqual(res, { ok: true, speak: 'Tubelight is off.' });
  registry.close();
});

test('device on calls set(true) and speaks', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'on', target: 'fan 1' }, { board, registry });
  assert.deepEqual(board.calls, [['fan 1', true]]);
  assert.deepEqual(res, { ok: true, speak: 'Fan 1 is on.' });
  registry.close();
});

test('group off expands to all members ordered by channel', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'off', target: 'lights' }, { board, registry });
  assert.deepEqual(board.calls, [
    ['tubelight', false], ['spotlight', false], ['rgb light', false], ['night light', false],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Lights are off.' });
  registry.close();
});

test('keep_only device turns target on and all other switches off', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'keep_only', target: 'tubelight' }, { board, registry });
  assert.deepEqual(board.calls, [
    ['fan 1', false],
    ['fan 2', false],
    ['tubelight', true],
    ['spotlight', false],
    ['rgb light', false],
    ['night light', false],
    ['socket', false],
    ['spare', false],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Only Tubelight is on.' });
  registry.close();
});

test('keep_only group turns group members on and all other switches off', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'keep_only', target: 'lights' }, { board, registry });
  assert.deepEqual(board.calls, [
    ['fan 1', false],
    ['fan 2', false],
    ['tubelight', true],
    ['spotlight', true],
    ['rgb light', true],
    ['night light', true],
    ['socket', false],
    ['spare', false],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Only Lights are on.' });
  registry.close();
});

test('all_off_except scoped to a group: turns off other group members, leaves target and non-group untouched', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route(
    { domain: 'switch', action: 'all_off_except', target: 'tubelight', scope: 'lights' },
    { board, registry },
  );
  // Only the OTHER lights are turned off; tubelight (the kept one) and fans/socket are untouched.
  assert.deepEqual(board.calls, [
    ['spotlight', false], ['rgb light', false], ['night light', false],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Lights off, except Tubelight.' });
  registry.close();
});

test('all_off_except global (no scope): turns off everything but the target', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route(
    { domain: 'switch', action: 'all_off_except', target: 'tubelight' },
    { board, registry },
  );
  assert.deepEqual(board.calls, [
    ['fan 1', false], ['fan 2', false],
    ['spotlight', false], ['rgb light', false], ['night light', false],
    ['socket', false], ['spare', false],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Everything off, except Tubelight.' });
  registry.close();
});

test('all_on turns every channel on', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'all_on' }, { board, registry });
  assert.deepEqual(board.calls, [
    ['fan 1', true], ['fan 2', true], ['tubelight', true], ['spotlight', true],
    ['rgb light', true], ['night light', true], ['socket', true], ['spare', true],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Everything is on.' });
  registry.close();
});

test('all_off calls board.allOff', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'all_off' }, { board, registry });
  assert.equal(board.allOffCalled, true);
  assert.deepEqual(res, { ok: true, speak: 'Everything is off.' });
  registry.close();
});

test('status reflects cached state', async () => {
  const registry = reg();
  const on = await route({ domain: 'switch', action: 'status', target: 'tubelight' }, { board: fakeBoard({ states: { tubelight: true } }), registry });
  assert.deepEqual(on, { ok: true, speak: 'The tubelight is on.' });
  const off = await route({ domain: 'switch', action: 'status', target: 'tubelight' }, { board: fakeBoard({ states: { tubelight: false } }), registry });
  assert.deepEqual(off, { ok: true, speak: 'The tubelight is off.' });
  registry.close();
});

test('status before first poll is graceful', async () => {
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'status', target: 'tubelight' }, { board: fakeBoard({ states: {} }), registry });
  assert.deepEqual(res, { ok: true, speak: "I haven't reached the smart switch yet." });
  registry.close();
});

test('pc open_app dispatches to the injected openApp capability', async () => {
  const calls = [];
  const openApp = (args) => { calls.push(args); return { ok: true, speak: 'Opening chrome.' }; };
  const registry = reg();
  const res = await route(
    { domain: 'pc', action: 'open_app', target: 'chrome' },
    { board: fakeBoard(), registry, openApp },
  );
  assert.deepEqual(calls, [{ name: 'chrome' }]);
  assert.deepEqual(res, { ok: true, speak: 'Opening chrome.' });
  registry.close();
});

test('pc with no openApp configured reports it gracefully', async () => {
  const registry = reg();
  const res = await route(
    { domain: 'pc', action: 'open_app', target: 'chrome' },
    { board: fakeBoard(), registry },
  );
  assert.equal(res.ok, false);
  assert.match(res.speak, /pc capability/i);
  registry.close();
});

test('pc with an unknown action returns ok:false', async () => {
  const registry = reg();
  const openApp = () => ({ ok: true, speak: 'no' });
  const res = await route(
    { domain: 'pc', action: 'eject_floppy', target: 'a:' },
    { board: fakeBoard(), registry, openApp },
  );
  assert.equal(res.ok, false);
  registry.close();
});

test('unreachable board yields the error sentence', async () => {
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'off', target: 'tubelight' }, { board: fakeBoard({ throwOnSet: true }), registry });
  assert.deepEqual(res, { ok: false, speak: "I couldn't reach the smart switch." });
  registry.close();
});

test('pc.media play_music -> music.play', async () => {
  const calls = [];
  const music = { play: (a) => { calls.push(a); return { ok: true, speak: 'playing' }; } };
  const registry = reg();
  const res = await route(
    { domain:'pc', action:'media', op:'play_music', arg:'daft punk' },
    { board: fakeBoard(), registry, music },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], { query: 'daft punk' });
  registry.close();
});

test('pc.media play_pause -> music.pauseResume; stop_music -> music.stop', async () => {
  const hits = [];
  const music = {
    pauseResume: () => { hits.push('pause'); return { ok: true, speak: 'toggling' }; },
    stop:        () => { hits.push('stop');  return { ok: true, speak: 'stopping' }; },
  };
  const registry = reg();
  await route({ domain:'pc', action:'media', op:'play_pause' }, { board: fakeBoard(), registry, music });
  await route({ domain:'pc', action:'media', op:'stop_music' }, { board: fakeBoard(), registry, music });
  assert.deepEqual(hits, ['pause', 'stop']);
  registry.close();
});

test('pc.browser search -> browser.search', async () => {
  const calls = [];
  const browser = { search: (a) => { calls.push(a); return { ok: true, speak: 'searching' }; } };
  const registry = reg();
  const res = await route(
    { domain:'pc', action:'browser', op:'search', arg:'cats' },
    { board: fakeBoard(), registry, browser },
  );
  assert.deepEqual(calls, [{ query: 'cats' }]);
  assert.equal(res.ok, true);
  registry.close();
});

test('pc.window split -> window.splitWith with openApp + sleep injected', async () => {
  const calls = [];
  const win = {
    splitWith: async (args, deps) => {
      calls.push({ args, hasOpenApp: !!deps.openApp });
      return { ok: true, speak: 'split done' };
    },
  };
  const openApp = () => ({ ok: true, speak: 'opened' });
  const registry = reg();
  const res = await route(
    { domain:'pc', action:'window', op:'split', a:'chrome', b:'code' },
    { board: fakeBoard(), registry, window: win, openApp },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0].args, { a: 'chrome', b: 'code' });
  assert.equal(calls[0].hasOpenApp, true);
  registry.close();
});

test('ask -> knowledge.answer', async () => {
  const calls = [];
  const knowledge = { answer: async (q) => { calls.push(q); return { ok: true, speak: 'A black hole is...' }; } };
  const registry = reg();
  const res = await route({ domain: 'ask', query: 'black holes' }, { board: fakeBoard(), registry, knowledge });
  assert.equal(res.ok, true);
  assert.equal(res.speak, 'A black hole is...');
  assert.deepEqual(calls, ['black holes']);
  registry.close();
});

test('persona overrides a successful switch confirmation', async () => {
  const persona = { phrase: (i) => (i.action === 'off' ? 'Tubelight powered down.' : null) };
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'off', target: 'tubelight' },
    { board: fakeBoard(), registry, persona });
  assert.equal(res.ok, true);
  assert.equal(res.speak, 'Tubelight powered down.');
  registry.close();
});

test('persona does not touch a failed result', async () => {
  const persona = { phrase: () => 'should not be used' };
  const registry = reg();
  const board = fakeBoard({ throwOnSet: true });
  const res = await route({ domain: 'switch', action: 'off', target: 'tubelight' }, { board, registry, persona });
  assert.equal(res.ok, false);
  assert.notEqual(res.speak, 'should not be used');
  registry.close();
});

test('vision -> vision.look with source and query', async () => {
  const calls = [];
  const vision = { look: async (a) => { calls.push(a); return { ok: true, speak: 'a red mug' }; } };
  const registry = reg();
  const res = await route({ domain: 'vision', source: 'camera', query: 'what is this' },
    { board: fakeBoard(), registry, vision });
  assert.equal(res.ok, true);
  assert.equal(res.speak, 'a red mug');
  assert.deepEqual(calls[0], { source: 'camera', query: 'what is this' });
  registry.close();
});

test('vision with no capability configured is graceful', async () => {
  const registry = reg();
  const res = await route({ domain: 'vision', source: 'camera', query: 'q' }, { board: fakeBoard(), registry });
  assert.equal(res.ok, false);
  assert.match(res.speak, /not configured/i);
  registry.close();
});

test('implicit vision falls back to knowledge when capture fails', async () => {
  const vision = { look: async () => ({ ok: false, speak: "I couldn't reach your phone's camera." }) };
  const knowledge = { answer: async (q) => ({ ok: true, speak: `Knowledge: ${q}` }) };
  const r = await route(
    { domain: 'vision', source: 'phone', query: 'how do i connect these', implicit: true },
    { vision, knowledge },
  );
  assert.equal(r.ok, true);
  assert.equal(r.speak, 'Knowledge: how do i connect these');
});

test('implicit vision returns the description when capture succeeds', async () => {
  const vision = { look: async () => ({ ok: true, speak: 'A tangle of cables.' }) };
  const knowledge = { answer: async () => { throw new Error('should not be called'); } };
  const r = await route({ domain: 'vision', source: 'phone', query: 'q', implicit: true }, { vision, knowledge });
  assert.equal(r.speak, 'A tangle of cables.');
});

test('explicit vision keeps the camera error (no knowledge fallback)', async () => {
  const vision = { look: async () => ({ ok: false, speak: "I couldn't reach your phone's camera." }) };
  const knowledge = { answer: async () => { throw new Error('should not be called'); } };
  const r = await route({ domain: 'vision', source: 'phone', query: 'q' }, { vision, knowledge });
  assert.equal(r.ok, false);
  assert.match(r.speak, /camera/i);
});

test('window list -> win.list()', async () => {
  const win = { list: async () => ({ ok: true, speak: 'You have Chrome open, sir.' }) };
  const registry = reg();
  const res = await route({ domain: 'pc', action: 'window', op: 'list' }, { board: fakeBoard(), registry, window: win });
  assert.equal(res.ok, true);
  assert.match(res.speak, /chrome/i);
  registry.close();
});

test('open_app with a machine routes to the pc agent', async () => {
  const calls = [];
  const agentClient = { run: async (url, body) => { calls.push({ url, body }); return { ok: true, detail: 'Opening steam.' }; } };
  const pcAgents = { get: (n) => (n === 'desktop' ? { name: 'desktop', base_url: 'http://x:7000' } : undefined) };
  const registry = reg();
  const res = await route({ domain: 'pc', action: 'open_app', target: 'steam', machine: 'desktop' },
    { board: fakeBoard(), registry, agentClient, pcAgents });
  assert.equal(res.ok, true);
  assert.equal(res.speak, 'Opening steam.');
  assert.equal(calls[0].url, 'http://x:7000');
  assert.deepEqual(calls[0].body, { capability: 'apps', action: 'open', params: { name: 'steam' } });
  registry.close();
});

test('a reachable-but-failed remote action surfaces its detail (not "couldn\'t reach")', async () => {
  const pcAgents = { get: () => ({ name: 'desktop', base_url: 'http://x:7000' }) };
  const registry = reg();
  // agent ran but the app launch failed -> detail is a real message, not 'unreachable'
  const failed = await route({ domain: 'pc', action: 'open_app', target: 'nope', machine: 'desktop' },
    { board: fakeBoard(), registry, pcAgents, agentClient: { run: async () => ({ ok: false, detail: "I couldn't open nope." }) } });
  assert.equal(failed.ok, false);
  assert.match(failed.speak, /couldn'?t open nope/i);
  // actual network failure -> 'unreachable' maps to the friendly couldn't-reach line
  const down = await route({ domain: 'pc', action: 'open_app', target: 'x', machine: 'desktop' },
    { board: fakeBoard(), registry, pcAgents, agentClient: { run: async () => ({ ok: false, detail: 'unreachable' }) } });
  assert.match(down.speak, /couldn'?t reach the desktop/i);
  registry.close();
});

test('open_app with an unknown machine is graceful', async () => {
  const pcAgents = { get: () => undefined };
  const registry = reg();
  const res = await route({ domain: 'pc', action: 'open_app', target: 'steam', machine: 'garage' },
    { board: fakeBoard(), registry, pcAgents, agentClient: { run: async () => ({ ok: true }) } });
  assert.equal(res.ok, false);
  assert.match(res.speak, /don'?t know a pc/i);
  registry.close();
});

test('open_app without a machine uses local openApp', async () => {
  let local = false;
  const openApp = () => { local = true; return { ok: true, speak: 'Opening steam.' }; };
  const registry = reg();
  await route({ domain: 'pc', action: 'open_app', target: 'steam' }, { board: fakeBoard(), registry, openApp });
  assert.equal(local, true);
  registry.close();
});

test('media transport op with a machine routes to the pc agent', async () => {
  const calls = [];
  const agentClient = { run: async (url, body) => { calls.push({ url, body }); return { ok: true, detail: 'Done.' }; } };
  const pcAgents = { get: () => ({ name: 'desktop', base_url: 'http://x:7000' }) };
  const registry = reg();
  const res = await route({ domain: 'pc', action: 'media', op: 'play_pause', machine: 'desktop' },
    { board: fakeBoard(), registry, agentClient, pcAgents });
  assert.equal(res.ok, true);
  assert.equal(res.speak, 'Done.');
  assert.deepEqual(calls[0].body, { capability: 'media', action: 'play_pause', params: {} });
  assert.equal(calls[0].url, 'http://x:7000');
  registry.close();
});

test('play_music with a machine is politely refused', async () => {
  const pcAgents = { get: () => ({ name: 'desktop', base_url: 'http://x' }) };
  const registry = reg();
  const res = await route({ domain: 'pc', action: 'media', op: 'play_music', arg: 'x', machine: 'desktop' },
    { board: fakeBoard(), registry, pcAgents, agentClient: { run: async () => ({ ok: true }) } });
  assert.equal(res.ok, false);
  assert.match(res.speak, /can'?t do that on the desktop/i);
  registry.close();
});

test('media transport op with a machine but unknown pc is graceful', async () => {
  const registry = reg();
  const res = await route({ domain: 'pc', action: 'media', op: 'next', machine: 'desktop' },
    { board: fakeBoard(), registry, pcAgents: { get: () => null }, agentClient: { run: async () => ({ ok: true }) } });
  assert.equal(res.ok, false);
  assert.match(res.speak, /don'?t know a pc called desktop/i);
  registry.close();
});

test('media op WITHOUT a machine still uses local media', async () => {
  let called = false;
  const media = { next: () => { called = true; return { ok: true, speak: 'Next.' }; } };
  const registry = reg();
  const res = await route({ domain: 'pc', action: 'media', op: 'next' }, { board: fakeBoard(), registry, media });
  assert.equal(called, true);
  assert.equal(res.ok, true);
  registry.close();
});

test('media transport op with a machine but no agent client is graceful', async () => {
  const registry = reg();
  const res = await route({ domain: 'pc', action: 'media', op: 'next', machine: 'desktop' },
    { board: fakeBoard(), registry, pcAgents: { get: () => ({ name: 'desktop', base_url: 'http://x' }) } });
  assert.equal(res.ok, false);
  assert.match(res.speak, /not configured/i);
  registry.close();
});
