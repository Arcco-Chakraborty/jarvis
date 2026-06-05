# Vision-by-Default — Design

**Date:** 2026-06-05
**Status:** Approved, pre-implementation
**Scope:** `orchestrator/intent/vision.js`, `orchestrator/intent/index.js`, `orchestrator/router.js`. No agent or `.env` changes.

## Problem & goal

Today the camera is only used when the user says an explicit trigger ("look at this", "what is this", "what do you see"). The user wants to *not* say those — to ask naturally, e.g. **"how do I connect these?"** or **"fix this"**, and have JARVIS use the phone camera by default, falling back gracefully when the camera is offline.

## Behavior

Add an **implicit-vision matcher** that runs in the intent cascade after explicit commands and explicit vision, but **before** `matchAsk` (knowledge). It returns:

```js
{ domain: 'vision', source: 'phone', query: <full normalized utterance>, implicit: true }
```

Source is always **phone** (screen vision is ditched / out of scope).

### Trigger rule (decision: option B)

The matcher fires when the utterance — after the earlier cascade stages (`switch → pc → explicit-vision`) have declined it — satisfies **either**:

1. **Demonstrative present:** contains a word referring to a physical thing — `this`, `that`, `these`, `those`, `here`. (Not "it" — too common, too many false grabs.)
2. **Bare help-phrasing:** matches `fix …` or `what's/what is wrong with …` even without a demonstrative.

And, specifically for `how do/can/would I …` / `how to …` / `what does … do`, a **demonstrative is required** (option B) — so "how do I connect **these**" fires but "how do I make pasta" does **not**.

This keeps obvious knowledge questions on the text path while capturing the deictic/visual ones.

### Example classification

| Utterance | Result |
|---|---|
| how do i connect these | camera (demonstrative + how-do-I) |
| what's wrong with this | camera (demonstrative; also bare help-verb) |
| fix this / fix the wiring | camera (bare `fix…`) |
| what does this button do | camera (demonstrative + what-does…do) |
| is this plugged in right | camera (demonstrative) |
| how do i make pasta | text (how-do-I, no demonstrative) |
| what's the capital of france | text (no demonstrative, not a help-verb) |
| what is this | camera (already caught by *explicit* vision) |

### Graceful fallback

The `implicit:true` flag changes router behavior on capture failure. In `router.js`'s vision branch:

- Call `vision.look({ source, query })`.
- If it succeeds → return its `{ ok, speak }` (unchanged).
- If it fails (camera unreachable, etc.) **and** `intent.implicit` is true **and** a `knowledge` capability is configured → return `knowledge.answer(query)` instead, so the user gets a normal spoken answer with no camera-error mention.
- Explicit vision (no `implicit` flag) keeps the current behavior: speak "I couldn't reach your phone's camera."

`vision.look` and `vision-answer.describe` are unchanged; the fallback is purely router-level orchestration.

## Architecture / boundaries

- **`vision.js`:** add `matchImplicitVision(text)` next to the existing `matchVision`. It owns the demonstrative/help-verb regexes and the option-B rule. Keeping it a separate exported function (rather than bloating `matchVision`) keeps explicit vs implicit triggers independently testable.
- **`index.js`:** insert `matchImplicitVision` into both `parseWithSource` and `parseLocal`, positioned after `matchVision` and before `matchAsk`. The Gemini classifier path is unchanged.
- **`router.js`:** the vision branch gains the `implicit` fallback to `knowledge.answer`. `knowledge` is already injected into `routeDeps`.

## Error handling

- Phone offline on an *implicit* request → silent text fallback (the goal).
- Phone offline on an *explicit* request → existing camera-error message.
- No `knowledge` configured (shouldn't happen in prod) → fall through to the normal vision failure message.

## Testing

- **`vision.test.js`:** `matchImplicitVision` fires for the "camera" rows above and returns `null` for the "text" rows; always `source:'phone'`, `implicit:true`, `query` = utterance.
- **`index.test.js`:** cascade ordering — an explicit "what is this" still routes via `matchVision` (no `implicit` flag); "how do i connect these" routes via the implicit matcher; "what's the capital of france" reaches `matchAsk`.
- **`router.test.js`:** implicit vision + failing capture + present `knowledge` → returns the knowledge answer (mock both); implicit vision + succeeding capture → returns the description; explicit vision + failing capture → camera-error message (no knowledge fallback).
- Manual: with the phone up, "how do i connect these" describes the scene; with the phone down, the same query answers from knowledge silently.

## Out of scope (YAGNI)

Screen vision; using "it" as a demonstrative; per-user tuning of the trigger set; vision for compound clauses beyond what the existing cascade already handles.
