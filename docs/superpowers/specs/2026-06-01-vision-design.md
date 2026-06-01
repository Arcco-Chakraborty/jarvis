# JARVIS Vision — "look at this" (design)

**Date:** 2026-06-01
**Status:** approved, pre-implementation
**Branch:** `vision`

## Motivation

Give JARVIS eyes: "look at this on my desk, what is it?" / "look at my screen, what's this error?" captures an image and sends it, with the spoken question, to Gemini (already multimodal via `gemini-2.5-flash`), then speaks the answer in the JARVIS voice. Reuses the rotation client (`callGemini`) built in the previous cycle.

**Decisions (brainstorming):**
- **Both sources** — webcam ("desk", "holding", default) and screen ("screen", "display").
- **Bare "look at this" defaults to webcam.**
- The orchestrator captures the image itself (it runs on the same box as the voice service), keeping the **voice service dumb** (audio + text only — design principle §5.4). Vision lives entirely in the orchestrator next to the Gemini brain.

**Out of scope:** screenshot downscaling (full-res for v1), continuous/video vision, multiple cameras.

## Architecture

```
voice "look at my desk, what is this?"  -> POST /command {text}
  cascade: switch -> pc -> VISION -> ask -> confirm -> gemini
  route(vision) -> vision.look({source, query})
        -> capture.camera()/screen()  (ffmpeg / gnome-screenshot -> base64)
        -> visionAnswer.describe(query, base64, mime)  (multimodal Gemini via callGemini)
        -> { ok, speak }  -> TTS
```

Four focused units, all injectable so they test without hardware or the API.

### 1. `intent/vision.js` (new, pure matcher)
`matchVision(text)` → `{ domain:'vision', source:'camera'|'screen', query }` or `null`.
- Same `normalize()` style as the other matchers (lowercase, strip leading "jarvis,", strip punctuation).
- **Trigger phrases** (anchored): `look at <X>`, `what is this`, `what's this`, `what am i holding`, `what's on my desk`, `describe this`, `what do you see`, and screen variants `look at (my|the) screen`, `what's on (my|the) screen`, `look at (my|the) display`.
- **source:** `screen` if the matched phrase names screen/display/monitor; otherwise `camera` (covers "desk", "holding", and bare "look at this").
- **query:** the utterance with the trigger phrase removed; if nothing remains, default to `"What do you see?"`. (e.g. "look at my desk what is this resistor" → source camera, query "what is this resistor"; "look at this" → camera, query "What do you see?".)
- Cascade placement: **after `matchPcCommand`, before `matchAsk`** in BOTH `parseWithSource` and `parseLocal` (so "what is this" routes to vision, not a knowledge lookup; and compound-splitting sees vision as a local intent — though a vision clause in a compound is fine, it just routes like any other).

### 2. `pc/capture.js` (new) — `makeCapture({ execFile, exists })`
Returns `{ camera(), screen() }`, each async → `{ ok:true, data:<base64>, mime } | { ok:false, speak:<reason> }`. Never throws.
- **`camera()`:** if `!exists('/dev/video0')` → `{ ok:false, speak:"I don't see a camera connected, sir." }`. Else `execFile('ffmpeg', ['-y','-f','v4l2','-i','/dev/video0','-frames:v','1','-vf','scale=1024:-1','-f','image2','-c:v','mjpeg','pipe:1'])`, capture stdout as a Buffer → base64, `mime='image/jpeg'`. On error → `{ ok:false, speak:"I couldn't get a picture from the camera." }`.
- **`screen()`:** capture to a temp PNG via `execFile('gnome-screenshot', ['-f', <tmp>])` (works on GNOME-Wayland through the portal), read the file → base64, `mime='image/png'`, unlink. If gnome-screenshot is missing (ENOENT) → `{ ok:false, speak:"I can't see the screen — gnome-screenshot isn't installed." }`. Other error → `{ ok:false, speak:"I couldn't capture the screen." }`.
- `execFile` is promisified with a buffer-friendly `maxBuffer` (images can exceed the 1 MB default) and a timeout (~10 s).

### 3. `intent/vision-answer.js` (new) — `makeVisionAnswer({ keys, fetchFn, model, timeoutMs })`
`describe(query, base64, mime)` → builds a multimodal body and routes through `callGemini` (rotation reused):
```js
body = {
  systemInstruction: { parts: [{ text: VISION_PERSONA }] },
  contents: [{ parts: [
    { text: query },
    { inlineData: { mimeType: mime, data: base64 } },
  ] }],
  generationConfig: { temperature: 0.4 },
}
```
`VISION_PERSONA`: the Stark-JARVIS voice, told it is looking at an image the user is showing it; answer in 1–3 spoken sentences, plain text (TTS). On `callGemini` → null or no text → in-character fallback (`ok:true`, spoken). Empty key list → an OFFLINE line. Never throws.

### 4. `pc/vision.js` (new) — `makeVision({ camera, screen, describe })`
`look({ source, query })` (async): pick `camera`/`screen` by `source`; `const shot = await cap();` if `!shot.ok` return `{ ok:false, speak: shot.speak }`; else `const speak = await describe(query, shot.data, shot.mime); return { ok:true, speak };`.

### Wiring
- **`router.js`:** add `vision` to the deps; `if (intent.domain === 'vision') return vision ? vision.look({ source: intent.source, query: intent.query }) : { ok:false, speak:'Vision capability not configured.' };` (placed alongside the `ask`/`pc` branches in `_route`). Persona wrapper untouched (vision results aren't control quips).
- **`server.js`:** construct `makeCapture()`, `makeVisionAnswer()`, `makeVision({ camera, screen, describe })` at boot; inject `vision` into both `route(...)` call sites and `makePipeline`.
- **`intent/index.js`:** import `matchVision`; insert into `parseWithSource` and `parseLocal` after pc, before ask.

## Error handling
- Capture failures return a spoken reason (`ok:false`) — the orchestrator speaks it; the voice loop treats `ok:false` normally (no crash).
- Gemini failures → in-character fallback (`ok:true`, spoken), as with knowledge.
- All four units never throw.

## Testing
- **`vision.js`:** "look at this" → camera + default query; "look at my desk what's this" → camera + "what's this"; "look at my screen" / "what's on screen" → screen; non-vision ("turn off the light", "play x") → null; query extraction correct; empty → default.
- **`capture.js`:** injected `execFile`+`exists` — camera builds the ffmpeg arg list and returns base64 of stdout; missing `/dev/video0` → graceful; screen calls gnome-screenshot with `-f <tmp>` and returns base64; ENOENT (tool missing) → graceful message.
- **`vision-answer.js`:** injected fetch — body contains a `text` part AND an `inlineData` part with the given mime+data; systemInstruction carries the persona; returns the answer text; failure (null data) → fallback; no keys → OFFLINE.
- **`vision.js` capability:** camera-source success calls `describe` with the captured data; capture-fail short-circuits to the error speak without calling `describe`; screen-source picks the screen fn.
- **`router.js`:** `domain:'vision'` → `vision.look` with source+query; no vision dep → graceful.
- **`index.js`:** "what is this" resolves to a vision intent locally (before ask/Gemini).

## Verification (on the box, after restart)
1. With a USB webcam: "hey jarvis, look at this, what am I holding?" → a spoken description of the object.
2. With `gnome-screenshot` installed: "hey jarvis, look at my screen, what's this error?" → a spoken reading of what's on screen.
3. No webcam plugged in: "look at this" → "I don't see a camera connected, sir." (graceful, no crash).
