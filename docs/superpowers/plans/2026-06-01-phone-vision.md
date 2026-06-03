# Phone Vision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the webcam vision source with a phone camera (IP Webcam snapshot URL over HTTP); keep screen; phone is the default for "look at this".

**Architecture:** `capture.js` drops `camera()` (ffmpeg) and gains `phone()` (HTTP GET → base64). The vision matcher's default source becomes `phone` (was `camera`) and gains phone-explicit triggers. `pc/vision.js` and the server boot route `phone`/`screen`. Reuses the existing multimodal-Gemini vision pipeline.

**Tech Stack:** Node ESM `node:test`, `fetch` (injected), the existing vision domain.

**Spec:** `docs/superpowers/specs/2026-06-01-phone-vision-design.md`
**Branch:** `phone-vision` (already created).

**Test command:** `npm test` / `node --test <file>`.

---

## File Structure
- `orchestrator/pc/capture.js` (modify) + `capture.test.js` (modify) — remove `camera()`, add `phone()`.
- `orchestrator/intent/vision.js` (modify) + `vision.test.js` (modify) — default `phone`, phone triggers.
- `orchestrator/pc/vision.js` (modify) + `pc/vision.test.js` (modify) — route `phone`/`screen`.
- `orchestrator/config.js` (modify) — `phoneCameraUrl`.
- `orchestrator/server.js` (modify) — wire `makeCapture({phoneUrl})` + `makeVision({phone,screen,describe})`.
- `.env.example` (modify) + local `.env` — `PHONE_CAMERA_URL`.

---

## Task 1: `capture.js` — remove `camera()`, add `phone()`

**Files:** `orchestrator/pc/capture.js`, `orchestrator/pc/capture.test.js`.

- [ ] **Step 1: Rewrite the relevant tests** — in `orchestrator/pc/capture.test.js`, DELETE the three `camera` tests (`'camera builds the ffmpeg pipeline...'`, `'camera reports no device gracefully'`, `'camera handles ffmpeg failure gracefully'`) and add these `phone` tests (keep the two `screen` tests as-is):

```js
test('phone fetches the snapshot URL and returns base64 jpeg', async () => {
  let calledUrl;
  const fetchFn = async (url) => {
    calledUrl = url;
    return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff]).buffer };
  };
  const cap = makeCapture({ fetchFn, phoneUrl: 'http://192.168.0.187:8080/photo.jpg' });
  const r = await cap.phone();
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(r.data, Buffer.from([0xff, 0xd8, 0xff]).toString('base64'));
  assert.equal(calledUrl, 'http://192.168.0.187:8080/photo.jpg');
});

test('phone falls back to image/jpeg when no content-type', async () => {
  const fetchFn = async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => Uint8Array.from([1]).buffer });
  const r = await makeCapture({ fetchFn, phoneUrl: 'http://x/photo.jpg' }).phone();
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/jpeg');
});

test('phone with no URL configured is graceful and does not fetch', async () => {
  let called = false;
  const cap = makeCapture({ fetchFn: async () => { called = true; return {}; }, phoneUrl: '' });
  const r = await cap.phone();
  assert.equal(r.ok, false);
  assert.match(r.speak, /phone camera/i);
  assert.equal(called, false);
});

test('phone reports an unreachable camera gracefully (non-ok and throw)', async () => {
  const notOk = await makeCapture({ fetchFn: async () => ({ ok: false, status: 500 }), phoneUrl: 'http://x' }).phone();
  assert.equal(notOk.ok, false);
  assert.match(notOk.speak, /reach your phone/i);
  const threw = await makeCapture({ fetchFn: async () => { throw new Error('ECONNREFUSED'); }, phoneUrl: 'http://x' }).phone();
  assert.equal(threw.ok, false);
  assert.match(threw.speak, /reach your phone/i);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/pc/capture.test.js`. FAIL (no `phone()`; `camera` tests gone).

- [ ] **Step 3: Implement** — in `orchestrator/pc/capture.js`:

(a) Update the header comment and the `makeCapture` signature; remove `existsSync` import (only `camera` used it). New top:
```js
// PC capability: capture — grabs an image for the vision feature.
//   phone():  a snapshot from a phone running an IP-Webcam app (HTTP GET -> base64).
//   screen(): a screenshot via gnome-screenshot (GNOME-Wayland portal).
// Each returns { ok:true, data:<base64>, mime } or { ok:false, speak:<reason> }.
// Never throws.
import { execFile as _execFile } from 'node:child_process';
import { readFile as _readFile, unlink as _unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXEC_OPTS = { timeout: 10000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' };

export function makeCapture({
  execFile = promisify(_execFile),
  readFile = _readFile,
  unlink = _unlink,
  fetchFn = fetch,
  phoneUrl = '',
} = {}) {
  return {
```

(b) DELETE the entire `async camera() { ... }` method.

(c) ADD the `phone()` method (place it where `camera()` was, before `screen()`):
```js
    async phone() {
      if (!phoneUrl) return { ok: false, speak: "I don't have a phone camera set up, sir." };
      try {
        const res = await fetchFn(phoneUrl, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return { ok: false, speak: "I couldn't reach your phone's camera." };
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = res.headers?.get?.('content-type') || 'image/jpeg';
        return { ok: true, data: buf.toString('base64'), mime };
      } catch {
        return { ok: false, speak: "I couldn't reach your phone's camera." };
      }
    },
```

(Leave `screen()` unchanged below it.)

- [ ] **Step 4: Run** — `node --test orchestrator/pc/capture.test.js`. All pass (phone + screen).

- [ ] **Step 5: Commit**
```bash
git add orchestrator/pc/capture.js orchestrator/pc/capture.test.js
git commit -m "pc: capture drops webcam camera(), adds phone() (IP Webcam snapshot)"
```

---

## Task 2: `intent/vision.js` — default phone + phone triggers

**Files:** `orchestrator/intent/vision.js`, `orchestrator/intent/vision.test.js`.

- [ ] **Step 1: Update the tests** — overwrite the body of `orchestrator/intent/vision.test.js`'s tests so the expected `source` for physical phrasings is `phone`, and add phone-explicit cases. Replace the existing `'bare ... camera'`, `'camera phrasings ...'`, and `'screen phrasings ...'` tests with:

```js
test('bare "look at this" -> phone with default query', () => {
  assert.deepEqual(matchVision('look at this'), { domain: 'vision', source: 'phone', query: 'What do you see?' });
  assert.deepEqual(matchVision('jarvis, look at that.'), { domain: 'vision', source: 'phone', query: 'What do you see?' });
});

test('physical phrasings carry the trailing question and use the phone', () => {
  assert.deepEqual(matchVision('look at this what is this'),
    { domain: 'vision', source: 'phone', query: 'what is this' });
  assert.deepEqual(matchVision('what am i holding'),
    { domain: 'vision', source: 'phone', query: 'What do you see?' });
  assert.deepEqual(matchVision('what is this'),
    { domain: 'vision', source: 'phone', query: 'What do you see?' });
});

test('phone-explicit phrasings -> phone', () => {
  assert.deepEqual(matchVision('look through my phone what is this'),
    { domain: 'vision', source: 'phone', query: 'what is this' });
  assert.deepEqual(matchVision('look at my phone'),
    { domain: 'vision', source: 'phone', query: 'What do you see?' });
  assert.deepEqual(matchVision('what am i doing'),
    { domain: 'vision', source: 'phone', query: 'What do you see?' });
});

test('screen phrasings -> screen source', () => {
  assert.deepEqual(matchVision('look at my screen'),
    { domain: 'vision', source: 'screen', query: 'What do you see?' });
  assert.deepEqual(matchVision("what's on my screen"),
    { domain: 'vision', source: 'screen', query: 'What do you see?' });
  assert.deepEqual(matchVision('look at the screen what does this say'),
    { domain: 'vision', source: 'screen', query: 'what does this say' });
});
```

(Keep the existing `'non-vision commands return null'` test as-is.)

- [ ] **Step 2: Run** — `node --test orchestrator/intent/vision.test.js`. FAIL (source is `camera`; phone/`what am i doing` triggers missing).

- [ ] **Step 3: Implement** — in `orchestrator/intent/vision.js`:

(a) Update the header comment's `'camera'|'screen'` to `'phone'|'screen'`.

(b) In the `TRIGGERS` array, change the comments from `// camera` to `// phone` and ADD these phone-explicit triggers (insert after the existing `look at ... desk|camera|webcam` line):
```js
  /^look (?:at|through) (?:my |the )?phone\b\s*(.*)$/,            // phone (explicit)
  /^use (?:my |the )?phone(?: camera)?\b\s*(.*)$/,                // phone (explicit)
  /^what am i doing\b\s*(.*)$/,                                   // phone
```

(c) In `matchVision`, change the returned source from `isScreen(norm) ? 'screen' : 'camera'` to:
```js
      return { domain: 'vision', source: isScreen(norm) ? 'screen' : 'phone', query };
```

- [ ] **Step 4: Run** — `node --test orchestrator/intent/vision.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/intent/vision.js orchestrator/intent/vision.test.js
git commit -m "intent: vision default source is phone; add phone-explicit triggers"
```

---

## Task 3: `pc/vision.js` — route phone/screen

**Files:** `orchestrator/pc/vision.js`, `orchestrator/pc/vision.test.js`.

- [ ] **Step 1: Update the tests** — in `orchestrator/pc/vision.test.js`, replace the camera-named tests so they use `phone`. Overwrite the file with:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVision } from './vision.js';

test('phone source: captures then describes', async () => {
  const seen = [];
  const phone = async () => ({ ok: true, data: 'IMG', mime: 'image/jpeg' });
  const screen = async () => { throw new Error('should not be called'); };
  const describe = async (q, data, mime) => { seen.push({ q, data, mime }); return 'a mug'; };
  const v = makeVision({ phone, screen, describe });
  const r = await v.look({ source: 'phone', query: 'what is this' });
  assert.equal(r.ok, true);
  assert.equal(r.speak, 'a mug');
  assert.deepEqual(seen, [{ q: 'what is this', data: 'IMG', mime: 'image/jpeg' }]);
});

test('default (no source) uses the phone capturer', async () => {
  let used = '';
  const phone = async () => { used = 'phone'; return { ok: true, data: 'P', mime: 'image/jpeg' }; };
  const screen = async () => { used = 'screen'; return { ok: true, data: 'S', mime: 'image/png' }; };
  const v = makeVision({ phone, screen, describe: async () => 'd' });
  await v.look({ query: 'q' });
  assert.equal(used, 'phone');
});

test('screen source: uses the screen capturer', async () => {
  let used = '';
  const phone = async () => { used = 'phone'; return { ok: true, data: 'P', mime: 'image/jpeg' }; };
  const screen = async () => { used = 'screen'; return { ok: true, data: 'S', mime: 'image/png' }; };
  const v = makeVision({ phone, screen, describe: async () => 'd' });
  await v.look({ source: 'screen', query: 'q' });
  assert.equal(used, 'screen');
});

test('capture failure short-circuits without describing', async () => {
  let described = false;
  const phone = async () => ({ ok: false, speak: "I couldn't reach your phone's camera." });
  const describe = async () => { described = true; return 'x'; };
  const v = makeVision({ phone, screen: phone, describe });
  const r = await v.look({ source: 'phone', query: 'q' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /phone/i);
  assert.equal(described, false);
});
```

- [ ] **Step 2: Run** — `node --test orchestrator/pc/vision.test.js`. FAIL (makeVision still expects `camera`).

- [ ] **Step 3: Implement** — overwrite `orchestrator/pc/vision.js`:
```js
// PC capability: vision — capture an image (phone or screen) then ask Gemini
// about it. capture fns + describe are injected (see capture.js, vision-answer.js).
export function makeVision({ phone, screen, describe } = {}) {
  return {
    async look({ source, query } = {}) {
      const cap = source === 'screen' ? screen : phone;
      const shot = await cap();
      if (!shot.ok) return { ok: false, speak: shot.speak };
      const speak = await describe(query, shot.data, shot.mime);
      return { ok: true, speak };
    },
  };
}
```

- [ ] **Step 4: Run** — `node --test orchestrator/pc/vision.test.js`. All pass.

- [ ] **Step 5: Commit**
```bash
git add orchestrator/pc/vision.js orchestrator/pc/vision.test.js
git commit -m "pc: vision routes phone (default) / screen"
```

---

## Task 4: config + server wiring + env

**Files:** `orchestrator/config.js`, `orchestrator/server.js`, `.env.example`, local `.env`.

- [ ] **Step 1: Add config** — in `orchestrator/config.js`, add to the `config` object (after `geminiApiKeys`):
```js
  phoneCameraUrl: process.env.PHONE_CAMERA_URL ?? '',
```

- [ ] **Step 2: Wire the server** — in `orchestrator/server.js`, change the vision construction block (currently `const capture = makeCapture(); ... const vision = makeVision({ camera: capture.camera, screen: capture.screen, describe: visionAnswer.describe });`) to:
```js
  const capture = makeCapture({ phoneUrl: config.phoneCameraUrl });
  const visionAnswer = makeVisionAnswer();
  const vision = makeVision({ phone: capture.phone, screen: capture.screen, describe: visionAnswer.describe });
```

- [ ] **Step 3: env** — in `.env.example`, add near the other voice/vision vars:
```
# Phone camera (IP Webcam app snapshot URL). Embed user:pass@ if it needs auth.
PHONE_CAMERA_URL=http://PHONE_IP:8080/photo.jpg
```
And in the LOCAL `.env` (gitignored), add the real value:
```
PHONE_CAMERA_URL=http://192.168.0.187:8080/photo.jpg
```
(Append it; do not disturb existing keys.)

- [ ] **Step 4: Verify** — `npm test` (all pass), then boot-import + config check:
```bash
node -e "import('./orchestrator/server.js').then(()=>console.log('import ok'))"
node --env-file=.env -e "import('./orchestrator/config.js').then(m=>console.log('phoneCameraUrl', JSON.stringify(m.config.phoneCameraUrl)))"
```
Expected: `import ok`, and `phoneCameraUrl "http://192.168.0.187:8080/photo.jpg"`.

- [ ] **Step 5: Commit** (only the tracked files — `.env` is gitignored and must not be committed):
```bash
git add orchestrator/config.js orchestrator/server.js .env.example
git commit -m "config+server: wire PHONE_CAMERA_URL into the vision capture source"
```

---

## Task 5: full suite, checkpoint, finish

**Files:** none code (verification); `CHECKPOINT.md`.

- [ ] **Step 1: Full suite** — `npm test`. All pass. Confirm no leftover `camera(`/`makeVision({ camera` references: `grep -rn "capture.camera\|camera:" orchestrator/*.js orchestrator/**/*.js` → none (only comments/history allowed).

- [ ] **Step 2: Update CHECKPOINT.md** — dated bullet: vision webcam source removed; phone camera added (`capture.phone()` HTTP-fetches `PHONE_CAMERA_URL`, an IP Webcam snapshot); phone is the default for "look at this"/"what is this", screen on "look at my screen"; `PHONE_CAMERA_URL` set to the user's phone in local `.env`. Commit:
```bash
git add CHECKPOINT.md && git commit -m "checkpoint: phone vision source (webcam retired)"
```

- [ ] **Step 3: Finish the branch** — use superpowers:finishing-a-development-branch to merge `phone-vision` into `main`.

- [ ] **Step 4: Hand off live e2e** (needs the user + phone): start the IP Webcam app on the phone (confirm `http://192.168.0.187:8080/photo.jpg` opens in a browser), restart via `./run-jarvis.sh`, then "look at this, what am I holding?" → spoken description; "look at my screen" → reads the screen.
```
