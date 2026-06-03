# Phone + Screen Vision — retire webcam, add phone camera (design)

**Date:** 2026-06-01
**Status:** approved, pre-implementation
**Branch:** `phone-vision`

## Motivation

This machine has no webcam, and there won't be one. Vision's two sources become:
- **phone** — the physical world, via a phone running an IP-Webcam-style app that serves a still snapshot over HTTP on the LAN. This is the **default** for "look"/"what is this" phrasings ("look at this", "look at what I'm doing", "what am I holding").
- **screen** — a screenshot, for "look at my screen" / "display".

This **retires the webcam source** (`camera()` — ffmpeg `/dev/video0`) and replaces it with `phone()` (HTTP fetch). The rest of the vision pipeline — multimodal `gemini-2.5-flash` via the rotating `callGemini`, JARVIS voice, the `vision` domain in the cascade/router — is unchanged.

**Decisions (brainstorming):** no webcam at all; phone is the default physical source; phone exposes a **snapshot URL** (IP Webcam app, e.g. `http://<phone-ip>:8080/photo.jpg`).

**Out of scope:** webcam (removed), live streaming / RTSP (snapshot only), multiple phones, auto-discovering the phone's IP.

## Architecture

```
"look at this, what is it?"  ->  vision matcher (source: phone, default)
"look at my screen ..."      ->  vision matcher (source: screen)
   route(vision) -> vision.look({source, query})
       -> capture.phone()  (HTTP GET <PHONE_CAMERA_URL> -> base64 jpeg)
          or capture.screen() (gnome-screenshot -> base64 png)
       -> visionAnswer.describe(query, base64, mime)  (multimodal Gemini)
       -> { ok, speak } -> TTS
```

### 1. `pc/capture.js` (modify)
- **Remove `camera()`** entirely (the ffmpeg/v4l2 `/dev/video0` path and its `exists` dependency for the camera). Drop the now-unused imports if nothing else needs them.
- **Add `phone()`** — `makeCapture({ fetchFn = fetch, phoneUrl = '', screen deps... })`. `phone()`:
  - If `!phoneUrl` → `{ ok:false, speak:"I don't have a phone camera set up, sir." }`.
  - Else `fetchFn(phoneUrl, { signal: AbortSignal.timeout(8000) })`; if `!res.ok` or it throws → `{ ok:false, speak:"I couldn't reach your phone's camera." }`.
  - On success, read the body as bytes (`arrayBuffer`) → base64; `mime` from the response `content-type` (default `image/jpeg`). Return `{ ok:true, data, mime }`.
  - Never throws.
- **Keep `screen()`** exactly as it is.

### 2. `intent/vision.js` (modify)
- `source` is now **`'phone' | 'screen'`**, default **`phone`** (rename the former `'camera'` default).
- Add phone-explicit triggers to the camera-class list: `look at (?:my |the )?phone`, `look through (?:my |the )?phone`, `use (?:my |the )?phone(?: camera)?`, `what(?:'s| is)? my phone (?:see|seeing|showing)`, `what am i doing`. The existing physical triggers ("look at this/that", "what is this", "what am I holding", "look at my desk", "describe this", "what do you see") stay and now resolve to **phone**.
- `isScreen(norm)` unchanged; when false the source is `phone` (was `camera`).
- (The "desk/camera/webcam" wording in a trigger can stay as phrasing that still routes to `phone` — they're just alternative ways to say "the physical world".)

### 3. `pc/vision.js` (modify)
- `makeVision({ phone, screen, describe })`; `look({source, query})` → `const cap = source === 'screen' ? screen : phone;` (rest unchanged).

### 4. Config + server
- `orchestrator/config.js`: add `phoneCameraUrl: process.env.PHONE_CAMERA_URL ?? ''`.
- `orchestrator/server.js`: `const capture = makeCapture({ phoneUrl: config.phoneCameraUrl });` and `makeVision({ phone: capture.phone, screen: capture.screen, describe: visionAnswer.describe })`.
- `.env.example`: `PHONE_CAMERA_URL=` with a comment (IP Webcam snapshot URL; embed `user:pass@` if the app needs auth).

## Error handling
- No `PHONE_CAMERA_URL` → spoken "I don't have a phone camera set up, sir."
- Phone unreachable / non-200 / timeout → spoken "I couldn't reach your phone's camera."
- Screen tool missing → existing graceful line. Gemini failure → existing in-character fallback. Nothing throws.

## Testing
- **`capture.js`:** `phone()` with injected `fetchFn` returning bytes → base64 + mime from content-type; no `phoneUrl` → graceful (fetch not called); fetch throws / non-ok → graceful. `camera()` no longer exists (remove its tests). `screen()` tests unchanged.
- **`vision.js` matcher:** "look at this" → `source:'phone'`; "look through my phone" / "what am i doing" → `phone`; "look at my screen" / "what's on screen" → `screen`; non-vision → null; query extraction intact.
- **`pc/vision.js`:** `look({source:'phone'})` calls the phone capturer + describes; `look({source:'screen'})` uses screen; capture-fail short-circuits without describing.
- **`server`/boot:** imports cleanly; `makeCapture({phoneUrl})` wired; vision uses phone+screen.

## Verification (on the box, after restart)
1. Phone running IP Webcam; `PHONE_CAMERA_URL` set: "hey jarvis, look at this, what am I holding?" → a spoken description from the phone's view.
2. "hey jarvis, look at my screen, what's this error?" → reads the screen.
3. No `PHONE_CAMERA_URL`: "look at this" → "I don't have a phone camera set up, sir." (graceful).
