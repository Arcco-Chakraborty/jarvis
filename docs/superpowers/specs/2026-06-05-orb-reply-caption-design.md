# Orb Reply Caption — Design

**Date:** 2026-06-05
**Status:** Approved, pre-implementation
**Scope:** Frontend only — `orchestrator/public/index.html`

## Problem

JARVIS speaks its replies through Piper TTS, but the user does not always have
audio output available. When a command is issued by voice, the dashboard orb
shows the user's *input* transcript and a transient "RESPONDING" label, but it
never displays the *text of JARVIS's reply*. With no audio, the user cannot tell
what JARVIS actually said.

## Goal

Show JARVIS's spoken reply as readable text on the orb after it responds, and
keep it visible long enough to read — specifically, until the next wake word.

## Key facts (already true, no change needed)

- The voice service (`voice-service/orchestrator.py`) POSTs each utterance to the
  orchestrator's `/command` and speaks back the returned `speak` string via TTS.
- The orchestrator records that exact `speak` string into in-memory telemetry
  (`orchestrator/telemetry.js` → `recordCommand`), exposed at `GET /log` as the
  most recent command's `.speak` field.
- The dashboard (`orchestrator/public/index.html`) already polls `/log` every
  1.5s via `pollLog()` and stores the latest entry as `lastCmd`.

So the reply text is already on the client. It is simply never rendered. This is
a display-only change; no backend, API, or test changes.

## Approach

Reuse the existing `#transcript` caption line beneath the orb (chosen over a
separate dedicated element to minimize layout surface). Render JARVIS's reply in
the amber "responding" color to distinguish it from the cyan user-input
transcript.

## Behavior

1. **Show.** When `pollLog()` observes a *new* command (its `ts` differs from the
   last one rendered) that carries a non-empty `speak`, write `▸ <speak>` into
   `#transcript`, set a `replyActive` flag, and apply an amber style class.
2. **Persist.** While `replyActive` is true, `pollVoice()` must NOT overwrite
   `#transcript` with the user's `lastTranscript` (it currently does this every
   500ms). This is what keeps the reply on screen instead of being wiped.
3. **Clear.** When the voice status transitions into a fresh wake cycle
   (status becomes `awake` or `recording`), clear `replyActive` and the amber
   style so the line resets for the new interaction. Net effect: the reply stays
   visible until the user says "hey jarvis" again.
4. **Orb pulse unchanged.** The orb's big animation still relaxes from RESPONDING
   back to IDLE on its existing ~3.5s `deriveState()` timer. Only the text
   caption persists, so the orb does not look perpetually "talking."
5. **Typed commands / quick switches unchanged.** They keep their existing 4s
   `flashTranscript` behavior; since they also produce a `/log` entry, the
   persist logic naturally extends to them without special-casing.

## State / wiring details

- New client state: a flag (e.g. `replyActive`) and a tracker for the last
  rendered command timestamp (e.g. `lastReplyTs`).
- `pollVoice()`'s existing guard that writes `lastTranscript` to `#transcript`
  must additionally check `!replyActive` (alongside the existing `flashUntil`
  guard).
- Wake detection uses the voice status already provided by `/voice`
  (`awake` / `recording`); no new signal required.
- Amber styling reuses the existing `--amber` token already used by the
  `body.speak` styles for visual consistency.

## Non-goals (YAGNI)

- No server-sent events / push; 1.5s polling lag is imperceptible here.
- No stacking of question + answer (single reply line only).
- No persistence across page reload.
- No backend, telemetry, or test changes.

## Testing

Manual, end-to-end via the existing run path:

1. `./run-jarvis.sh`, open the dashboard.
2. Say "hey jarvis" → a command (e.g. "pause on the desktop").
3. Confirm the orb caption shows `▸ <reply>` in amber and stays after the orb
   calms to IDLE.
4. Say "hey jarvis" again → confirm the caption clears for the new interaction.
5. Confirm typed commands and quick-switch buttons still show their replies.
