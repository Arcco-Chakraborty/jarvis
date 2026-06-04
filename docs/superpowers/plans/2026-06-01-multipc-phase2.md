# Multi-PC Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** "pause / next / volume up on the \<pc\>" sends media keys, and "run \<cmd\> on the \<pc\>" runs a confirm-gated PowerShell command, on a remote Windows agent.

**Architecture:** Two new agent capabilities (`media`, `shell`). The orchestrator generalizes "on the \<pc\>" targeting to open_app/media/shell, routes remote media ops to the agent, and routes the confirm-gated shell flow to the agent when a machine is targeted.

**Tech Stack:** Node ESM `node:test`, stdlib (agent), injected `spawn`/`fetch`.

**Spec:** `docs/superpowers/specs/2026-06-01-multipc-phase2-design.md`
**Branch:** `multipc-phase2`.

**Test command:** `npm test` / `node --test <file>`.

---

## Task 1: agent `media` capability

**Files:** Create `pc-agent/capabilities/media.js`, `pc-agent/capabilities/media.test.js`.

- [ ] **Step 1: Failing test** — `pc-agent/capabilities/media.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMedia } from './media.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  return { calls, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; } };
}

test('media exposes the transport actions', () => {
  const m = makeMedia({ spawn: rec().spawn });
  assert.equal(m.name, 'media');
  for (const a of ['play_pause', 'next', 'prev', 'volume_up', 'volume_down', 'mute']) {
    assert.equal(typeof m.actions[a], 'function', a);
  }
});

test('each action sends its media virtual-key via powershell keybd_event', () => {
  const vks = { play_pause: '0xB3', next: '0xB0', prev: '0xB1', volume_up: '0xAF', volume_down: '0xAE', mute: '0xAD' };
  for (const [action, vk] of Object.entries(vks)) {
    const r = rec();
    const res = makeMedia({ spawn: r.spawn }).actions[action]();
    assert.equal(res.ok, true);
    assert.equal(r.calls[0].bin, 'powershell');
    const script = r.calls[0].args.join(' ');
    assert.match(script, /keybd_event/);
    assert.ok(script.includes(vk), `${action} should send ${vk}`);
  }
});

test('a spawn error is graceful', () => {
  const res = makeMedia({ spawn: () => { throw new Error('x'); } }).actions.play_pause();
  assert.equal(res.ok, false);
});
```

- [ ] **Step 2: Run** — `node --test pc-agent/capabilities/media.test.js`. FAIL.

- [ ] **Step 3: Implement** — `pc-agent/capabilities/media.js`:
```js
// Agent capability: media — send Windows media/volume keys via keybd_event
// (controls whatever app currently has media-key focus).
import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };
const VK = { play_pause: '0xB3', next: '0xB0', prev: '0xB1', volume_up: '0xAF', volume_down: '0xAE', mute: '0xAD' };

function press(spawn, vk) {
  const script =
    "$s='[DllImport(\"user32.dll\")]public static extern void keybd_event(byte b,byte s,uint f,int e);';" +
    "$k=Add-Type -MemberDefinition $s -Name K -Namespace W -PassThru;" +
    `$k::keybd_event(${vk},0,0,0);`;
  try {
    const p = spawn('powershell', ['-NoProfile', '-Command', script], OPTS);
    p?.unref?.();
    return { ok: true, detail: 'Done.' };
  } catch {
    return { ok: false, detail: "I couldn't do that." };
  }
}

export function makeMedia({ spawn = _spawn } = {}) {
  const actions = {};
  for (const [name, vk] of Object.entries(VK)) actions[name] = () => press(spawn, vk);
  return { name: 'media', actions };
}
```

- [ ] **Step 4: Run** — `node --test pc-agent/capabilities/media.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add pc-agent/capabilities/media.js pc-agent/capabilities/media.test.js
git commit -m "pc-agent: media capability (Windows media/volume keys via keybd_event)"
```

---

## Task 2: agent `shell` capability + boot wiring

**Files:** Create `pc-agent/capabilities/shell.js`, `pc-agent/capabilities/shell.test.js`; modify `pc-agent/index.js`.

- [ ] **Step 1: Failing test** — `pc-agent/capabilities/shell.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeShell } from './shell.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  return { calls, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; } };
}

test('shell exposes a run action', () => {
  const s = makeShell({ spawn: rec().spawn });
  assert.equal(s.name, 'shell');
  assert.equal(typeof s.actions.run, 'function');
});

test('run executes the command via powershell -Command', () => {
  const r = rec();
  const res = makeShell({ spawn: r.spawn }).actions.run({ command: 'dir' });
  assert.equal(res.ok, true);
  assert.equal(r.calls[0].bin, 'powershell');
  assert.deepEqual(r.calls[0].args, ['-NoProfile', '-Command', 'dir']);
});

test('run refuses an empty command', () => {
  assert.equal(makeShell({ spawn: rec().spawn }).actions.run({ command: '' }).ok, false);
});

test('a spawn error is graceful', () => {
  const res = makeShell({ spawn: () => { throw new Error('x'); } }).actions.run({ command: 'dir' });
  assert.equal(res.ok, false);
});
```

- [ ] **Step 2: Run** — `node --test pc-agent/capabilities/shell.test.js`. FAIL.

- [ ] **Step 3: Implement** — `pc-agent/capabilities/shell.js`:
```js
// Agent capability: shell — run a PowerShell command. The orchestrator gates
// this behind a spoken "confirm"; the agent only runs what an authed caller sends.
import { spawn as _spawn } from 'node:child_process';

const OPTS = { detached: true, stdio: 'ignore' };

export function makeShell({ spawn = _spawn } = {}) {
  return {
    name: 'shell',
    actions: {
      run({ command } = {}) {
        const cmd = String(command ?? '').trim();
        if (!cmd) return { ok: false, detail: 'no command' };
        try {
          const p = spawn('powershell', ['-NoProfile', '-Command', cmd], OPTS);
          p?.unref?.();
          return { ok: true, detail: 'Done.' };
        } catch {
          return { ok: false, detail: "I couldn't run that." };
        }
      },
    },
  };
}
```

- [ ] **Step 4: Update boot** — `pc-agent/index.js`, load all three capabilities:
```js
import { start } from './server.js';
import { makeApps } from './capabilities/apps.js';
import { makeMedia } from './capabilities/media.js';
import { makeShell } from './capabilities/shell.js';

const token = process.env.PC_AGENT_TOKEN ?? '';
if (!token) console.warn('WARNING: PC_AGENT_TOKEN is empty — /run will reject everything.');
start({ capabilities: [makeApps(), makeMedia(), makeShell()], token });
```

- [ ] **Step 5: Run** — `node --test pc-agent/capabilities/shell.test.js` (pass) and `node --check pc-agent/index.js`.

- [ ] **Step 6: Commit**
```bash
git add pc-agent/capabilities/shell.js pc-agent/capabilities/shell.test.js pc-agent/index.js
git commit -m "pc-agent: shell capability (PowerShell) + load apps/media/shell at boot"
```

---

## Task 3: intent — generalize "on the <pc>" to media/shell/open_app

**Files:** `orchestrator/intent/pc.js`, `orchestrator/intent/pc.test.js`.

- [ ] **Step 1: Failing tests** — in `orchestrator/intent/pc.test.js`, add:
```js
test('media transport "on the <pc>" carries a machine', () => {
  assert.deepEqual(matchPcCommand('pause on the desktop', { pcNames: ['desktop'] }),
    { domain: 'pc', action: 'media', op: 'play_pause', machine: 'desktop' });
  assert.deepEqual(matchPcCommand('volume up on the desktop', { pcNames: ['desktop'] }),
    { domain: 'pc', action: 'media', op: 'volume_up', machine: 'desktop' });
  assert.deepEqual(matchPcCommand('next on the desktop', { pcNames: ['desktop'] }),
    { domain: 'pc', action: 'media', op: 'next', machine: 'desktop' });
});
test('shell "run <cmd> on the <pc>" carries a machine', () => {
  assert.deepEqual(matchPcCommand('run dir on the desktop', { pcNames: ['desktop'] }),
    { domain: 'pc', action: 'shell', target: 'dir', machine: 'desktop' });
});
test('open_app on the pc still works (phase-1 parity)', () => {
  assert.deepEqual(matchPcCommand('open steam on the desktop', { pcNames: ['desktop'] }),
    { domain: 'pc', action: 'open_app', target: 'steam', machine: 'desktop' });
});
test('bare commands have no machine; unknown pc stays in text', () => {
  assert.deepEqual(matchPcCommand('pause', { pcNames: ['desktop'] }), { domain: 'pc', action: 'media', op: 'play_pause' });
  assert.deepEqual(matchPcCommand('run dir', { pcNames: ['desktop'] }), { domain: 'pc', action: 'shell', target: 'dir' });
  assert.deepEqual(matchPcCommand('pause on the laptop', { pcNames: ['desktop'] }), null); // "pause on the laptop" isn't a media phrase
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/intent/pc.test.js`. FAIL.

- [ ] **Step 3: Implement** — in `orchestrator/intent/pc.js`:
(a) Rename `splitMachine(target, pcNames)` to `stripMachine(text, pcNames)` returning `{ text, machine }` (same regex, but operating on the whole text):
```js
// Strip a trailing "on (the) <known-pc>" -> { text, machine } (machine null if none).
function stripMachine(text, pcNames) {
  for (const name of pcNames) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = String(text).match(new RegExp(`^(.+?)\\s+on\\s+(?:the\\s+)?${esc}$`));
    if (m) return { text: m[1].trim(), machine: name };
  }
  return { text, machine: null };
}
```
(b) At the top of `matchPcCommand`, after computing `norm`, strip the machine and define a helper:
```js
export function matchPcCommand(text, vocab = {}) {
  const raw = normalize(text);
  if (!raw) return null;
  const { text: norm, machine } = stripMachine(raw, vocab.pcNames ?? []);
  const withMachine = (intent) => (machine ? { ...intent, machine } : intent);
```
(c) Use `withMachine(...)` on the **open_app**, **media (all three media return points: MEDIA_FIXED loop, play_music, set_volume)**, and **shell** returns. The open_app branch becomes:
```js
  const open = norm.match(/^(?:open|launch|start)\s+(.+)$/);
  if (open) {
    const target = open[1].replace(/^the\s+/, '').trim();
    if (target) return withMachine({ domain: 'pc', action: 'open_app', target });
  }
```
Media loop: `if (re.test(norm)) return withMachine({ domain: 'pc', action: 'media', op });`. play_music: `return withMachine({ domain: 'pc', action: 'media', op: 'play_music', arg: playQ[1].trim() });`. set_volume: `return withMachine({ domain: 'pc', action: 'media', op: 'set_volume', arg: n });`. Shell: `return withMachine({ domain: 'pc', action: 'shell', target: run[1].trim() });`. Leave window/search/split returns WITHOUT `withMachine` (local-only). Remove the old `splitMachine` (no longer used).

- [ ] **Step 4: Run** — `node --test orchestrator/intent/pc.test.js`, then `npm test`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/pc.js orchestrator/intent/pc.test.js
git commit -m "intent: strip 'on the <pc>' once -> machine on open_app/media/shell"
```

---

## Task 4: router — remote media

**Files:** `orchestrator/router.js`, `orchestrator/router.test.js`.

- [ ] **Step 1: Failing tests** — in `orchestrator/router.test.js`, add (use the file's per-test `reg()` pattern):
```js
test('media transport op with a machine routes to the pc agent', async () => {
  const calls = [];
  const agentClient = { run: async (url, body) => { calls.push({ url, body }); return { ok: true, detail: 'Done.' }; } };
  const pcAgents = { get: () => ({ name: 'desktop', base_url: 'http://x:7000' }) };
  const registry = reg();
  const res = await route({ domain: 'pc', action: 'media', op: 'play_pause', machine: 'desktop' },
    { board: fakeBoard(), registry, agentClient, pcAgents });
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0].body, { capability: 'media', action: 'play_pause', params: {} });
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
test('media op without a machine uses local media', async () => {
  let local = false;
  const media = { playPause: () => { local = true; return { ok: true, speak: 'Toggling.' }; } };
  const registry = reg();
  await route({ domain: 'pc', action: 'media', op: 'play_pause' }, { board: fakeBoard(), registry, media, music: { pauseResume: () => ({ ok: true, speak: 'x' }) } });
  // (local play_pause routes to music.pauseResume per current code; just assert it didn't go remote — no agentClient provided and it didn't throw)
  registry.close();
});
```
(Note: local `play_pause` currently routes to `music.pauseResume()`. The third test just confirms the no-machine path stays local and doesn't require an agent. Adjust the assertion to match the existing local media test style in the file if needed.)

- [ ] **Step 2: Run** — `node --test orchestrator/router.test.js`. FAIL.

- [ ] **Step 3: Implement** — in `orchestrator/router.js`:
(a) Add a module-scope helper (near the top, after `capitalize`) to DRY the remote-result speak:
```js
function remoteSpeak(r, machine) {
  if (r.ok) return { ok: true, speak: r.detail || `Done on ${machine}.` };
  const unreachable = !r.detail || r.detail === 'unreachable';
  return { ok: false, speak: unreachable ? `I couldn't reach the ${machine}.` : r.detail };
}
```
And refactor the existing open_app remote return to use it: `const r = await agentClient.run(...); return remoteSpeak(r, intent.machine);`.
(b) At the TOP of the `if (intent.action === 'media')` block, add the remote branch:
```js
    if (intent.action === 'media') {
      if (intent.machine) {
        const REMOTE = new Set(['play_pause', 'next', 'prev', 'volume_up', 'volume_down', 'mute']);
        if (!REMOTE.has(intent.op)) return { ok: false, speak: `I can't do that on the ${intent.machine} yet.` };
        const a = pcAgents?.get?.(intent.machine);
        if (!a) return { ok: false, speak: `I don't know a PC called ${intent.machine}.` };
        if (!agentClient) return { ok: false, speak: 'PC agent client not configured.' };
        const r = await agentClient.run(a.base_url, { capability: 'media', action: intent.op, params: {} });
        return remoteSpeak(r, intent.machine);
      }
      const nc = (w) => ({ ok: false, speak: `${w} capability not configured.` });
      switch (intent.op) {
        // ... existing local cases unchanged ...
```

- [ ] **Step 4: Run** — `node --test orchestrator/router.test.js`, then `npm test`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/router.js orchestrator/router.test.js
git commit -m "router: remote media transport ops; DRY remoteSpeak helper"
```

---

## Task 5: pipeline — remote confirm-gated shell

**Files:** `orchestrator/server.js`, `orchestrator/server.test.js`.

- [ ] **Step 1: Failing test** — in `orchestrator/server.test.js`, add (match the `pipelineWith`/`setIntent` helper; if it doesn't accept agentClient/pcAgents, extend that helper minimally and report):
```js
test('pipeline: a remote shell command is gated then run on the agent', async () => {
  const ran = [];
  const agentClient = { run: async (url, body) => { ran.push({ url, body }); return { ok: true, detail: 'Done.' }; } };
  const pcAgents = { get: () => ({ name: 'desktop', base_url: 'http://x:7000' }) };
  const p = makePipeline({
    parse: async (t) => (t === 'confirm' ? { intent: { domain: 'confirm', action: 'yes' }, via: 'rules' } : { intent: { domain: 'pc', action: 'shell', target: 'dir', machine: 'desktop' }, via: 'rules' }),
    vocab: {}, route: async () => ({ ok: false, speak: 'x' }), agentClient, pcAgents, now: () => 1000, ttlMs: 60000,
  });
  const r1 = await p.onCommand('run dir on the desktop');
  assert.match(r1.speak, /should i run dir on the desktop/i);
  assert.equal(ran.length, 0); // gated
  const r2 = await p.onCommand('confirm');
  assert.deepEqual(ran[0].body, { capability: 'shell', action: 'run', params: { command: 'dir' } });
  assert.equal(ran[0].url, 'http://x:7000');
  assert.match(r2.speak, /done/i);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/server.test.js`. FAIL.

- [ ] **Step 3: Implement** — in `orchestrator/server.js` `makePipeline`:
(a) Shell-intent handler — make the command literal when a machine is set, and store the machine on `pending`:
```js
    if (intent?.domain === 'pc' && intent.action === 'shell') {
      const literal = typeof intent.command === 'string' ? intent.command.trim() : '';
      const cmd = intent.machine ? (literal || String(intent.target ?? '').trim()) : (literal || shell?.lookup?.(intent.target));
      if (!cmd) {
        pending = null;
        const why = intent.target ? `I don't have a recipe called ${intent.target}.` : "I'm not sure what to run.";
        return log(text, intent, via, false, why);
      }
      pending = { command: cmd, machine: intent.machine ?? null, expiresAt: now() + ttlMs };
      const where = intent.machine ? ` on the ${intent.machine}` : '';
      return log(text, intent, via, true, `Should I run ${cmd}${where}? Say confirm to run.`);
    }
```
(b) Confirm handler — route to the agent if the pending has a machine:
```js
    if (intent?.domain === 'confirm' && intent.action === 'yes') {
      if (!fresh()) { pending = null; return log(text, intent, via, false, "There's nothing to confirm."); }
      const { command, machine } = pending; pending = null;
      if (machine) {
        const a = pcAgents?.get?.(machine);
        if (!a || !agentClient) return log(text, intent, via, false, `I couldn't reach the ${machine}.`);
        const r = await agentClient.run(a.base_url, { capability: 'shell', action: 'run', params: { command } });
        return log(text, intent, via, r.ok, r.ok ? (r.detail || `Done on ${machine}.`) : `I couldn't reach the ${machine}.`);
      }
      const { ok, speak } = shell ? shell.execute(command) : { ok: false, speak: 'Shell capability not configured.' };
      return log(text, intent, via, ok, ok ? `Running ${command}.` : speak);
    }
```
(`pending.command` was the field name before; keep it. `agentClient`/`pcAgents` are already makePipeline params.)

- [ ] **Step 4: Run** — `node --test orchestrator/server.test.js`, then `npm test`. All pass. Boot check: `node -e "import('./orchestrator/server.js').then(()=>console.log('import ok'))"`.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/server.js orchestrator/server.test.js
git commit -m "pipeline: confirm-gated shell routes to the remote agent when targeted"
```

---

## Task 6: full suite, checkpoint, finish

**Files:** none code (verification); `CHECKPOINT.md`.

- [ ] **Step 1: Full suite** — `npm test`. All pass.

- [ ] **Step 2: CHECKPOINT.md** — dated bullet: multi-PC Phase 2 — agent gains `media` (Windows media/volume keys via keybd_event) + `shell` (PowerShell, confirm-gated by the orchestrator); "on the \<pc\>" now targets media/shell too (generalized strip in `intent/pc.js`); router routes remote media transport ops; the pipeline confirm-flow runs the command on the agent when a machine is targeted (literal command, never without spoken confirm). Out of scope: remote play-a-song, system/power. Commit it.

- [ ] **Step 3: Finish** — superpowers:finishing-a-development-branch to merge `multipc-phase2` into `main`, then push (`git push origin main`).

- [ ] **Step 4: Host handoff** — pull/update the Windows agent, restart `node pc-agent/index.js` (`/health` now lists apps, media, shell). Then: "pause on the desktop", "volume up on the desktop", "run notepad on the desktop" → "confirm".
