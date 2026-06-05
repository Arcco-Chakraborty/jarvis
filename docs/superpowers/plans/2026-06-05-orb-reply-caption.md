# Orb Reply Caption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display JARVIS's spoken reply as text on the dashboard orb after it responds, persisting until the next wake word, so it's readable without audio output.

**Architecture:** Frontend-only change to the existing dashboard. The reply text already arrives on the client via the `/log` poll (`lastCmd.speak`); it is simply never rendered. We render it into the existing `#transcript` caption line in an amber style, hold it there by suppressing the normal input-transcript overwrite while a reply is active, and clear it when a fresh wake cycle (`awake`/`recording`) begins.

**Tech Stack:** Vanilla JS + CSS inside `orchestrator/public/index.html` (single static file, inline `<script>`). No build step. No backend, API, or test changes.

---

## Testing note

`orchestrator/public/index.html` is a single static HTML file with an inline script and **no client-side test harness** — the repo's 293 automated tests are server-side and do not exercise this file. Introducing a DOM test framework solely for this small change would be unjustified new infrastructure and would require restructuring the monolithic inline script. Therefore verification for every task is **manual, in-browser**, consistent with how the rest of this dashboard is verified. Each task below states exactly what to observe.

## File structure

Only one file changes:

- **Modify:** `orchestrator/public/index.html`
  - CSS: add a `.transcript.reply` amber style (near the existing `.transcript` rule, line ~296).
  - JS state: add `replyActive` and `lastReplyTs` (near the existing `let lastCmd = null;`, line ~509).
  - JS `pollLog()`: render a new reply when `lastCmd` changes (lines ~648-654).
  - JS `pollVoice()`: clear the reply on a fresh wake, and suppress the input-transcript overwrite while a reply is active (lines ~601-603).

No new files. No other files touched.

---

## Task 1: Add the amber reply caption style

**Files:**
- Modify: `orchestrator/public/index.html` (CSS, near line 296)

- [ ] **Step 1: Add the style rule**

Find this existing rule (line ~296):

```css
  .transcript { margin: 14px auto 0; min-height: 1.6em; font-family: var(--ui); font-weight: 600; font-size: 1.05rem; color: var(--cyan-soft); letter-spacing: 0.06em; text-shadow: 0 0 14px rgba(79,230,255,0.4); max-width: 540px; }
```

Immediately AFTER it (before the `.transcript:empty::before` rule on the next line), insert:

```css
  .transcript.reply { color: var(--amber-soft); text-shadow: 0 0 16px rgba(255,178,62,0.5); }
```

(`--amber-soft` = `#ffd07a`, already defined at line ~19. This makes JARVIS's reply read in warm amber vs. the cyan user-input transcript.)

- [ ] **Step 2: Verify nothing broke**

Run: `cd orchestrator && node -e "require('fs').readFileSync('public/index.html','utf8')"`
Expected: no output, exit 0 (file still readable; this is a smoke check only — the real check is visual in later tasks).

No commit yet — committed together at the end of Task 4 after manual verification (the intermediate states are non-functional on their own).

---

## Task 2: Add reply state variables

**Files:**
- Modify: `orchestrator/public/index.html` (JS, near line 509)

- [ ] **Step 1: Add the state vars**

Find this existing line (line ~509):

```javascript
let lastCmd = null;
```

Immediately AFTER it, insert:

```javascript
let replyActive = false;   // true while JARVIS's reply caption is being shown
let lastReplyTs = 0;       // ts of the last /log command we've already handled
```

- [ ] **Step 2: Confirm placement**

Run: `grep -n "let replyActive\|let lastReplyTs\|let lastCmd" orchestrator/public/index.html`
Expected: three consecutive line numbers, `lastCmd` first.

No commit yet (see Task 1 note).

---

## Task 3: Render the reply when a new command arrives

**Files:**
- Modify: `orchestrator/public/index.html` (`pollLog`, lines ~648-654)

- [ ] **Step 1: Update `pollLog()`**

Find this existing function (lines ~648-654):

```javascript
async function pollLog() {
  try {
    const j = await jget("/log");
    if (j && Array.isArray(j.commands) && j.commands.length) lastCmd = j.commands[0];
    else lastCmd = null;
  } catch (_) {}
}
```

Replace it entirely with:

```javascript
async function pollLog() {
  try {
    const j = await jget("/log");
    if (j && Array.isArray(j.commands) && j.commands.length) lastCmd = j.commands[0];
    else lastCmd = null;
    // Surface JARVIS's reply on the orb. Only for a genuinely new, fresh
    // command — skip stale entries loaded on page open so we don't flash an
    // old reply. lastReplyTs is bumped either way so we evaluate each once.
    if (lastCmd && lastCmd.ts !== lastReplyTs) {
      lastReplyTs = lastCmd.ts;
      if (lastCmd.speak && (Date.now() - lastCmd.ts) < 3500) {
        replyActive = true;
        $("#transcript").textContent = "▸ " + lastCmd.speak;
        $("#transcript").classList.add("reply");
      }
    }
  } catch (_) {}
}
```

- [ ] **Step 2: Confirm the edit**

Run: `grep -n "replyActive = true" orchestrator/public/index.html`
Expected: one match inside `pollLog`.

No commit yet (see Task 1 note).

---

## Task 4: Persist the reply and clear it on the next wake

**Files:**
- Modify: `orchestrator/public/index.html` (`pollVoice`, lines ~601-603)

- [ ] **Step 1: Update the transcript-writing block in `pollVoice()`**

Find this existing block inside `pollVoice()` (lines ~601-603):

```javascript
    if (Date.now() > flashUntil) {
      $("#transcript").textContent = lastVoice.lastTranscript ? "“" + lastVoice.lastTranscript + "”" : "";
    }
```

Replace it with:

```javascript
    // A fresh wake cycle ends any reply we were holding, so the new turn's
    // input can show. (awake/recording only occur at the start of a turn.)
    if (replyActive && (lastVoice.status === "awake" || lastVoice.status === "recording")) {
      replyActive = false;
      $("#transcript").classList.remove("reply");
    }
    // While a reply is held, don't overwrite it with the input transcript.
    if (!replyActive && Date.now() > flashUntil) {
      $("#transcript").textContent = lastVoice.lastTranscript ? "“" + lastVoice.lastTranscript + "”" : "";
    }
```

- [ ] **Step 2: Confirm the edit**

Run: `grep -n "replyActive && (lastVoice.status" orchestrator/public/index.html`
Expected: one match inside `pollVoice`.

- [ ] **Step 3: Manual end-to-end verification**

Start the stack and open the dashboard:

```bash
./run-jarvis.sh
```

Open the dashboard URL in a browser (the orchestrator serves `index.html` at its root, e.g. `http://localhost:3000/` — confirm the port from the run output).

Verify, in order:

1. **Voice reply shows & persists.** Say "hey jarvis" → "pause on the desktop" (or any command that returns speech, e.g. "are the lights on"). The orb caption under it shows `▸ <JARVIS's reply>` in **amber**, and it **stays visible** after the orb's glow relaxes back to IDLE (~3.5s later).
2. **Cleared on next wake.** Say "hey jarvis" again. The amber reply clears as the new turn starts (caption returns to cyan input / empty).
3. **Typed command still works.** Type a command into the command box and press Enter. Its reply appears (and now also persists in amber until the next wake) — confirm nothing regressed.
4. **No stale reply on reload.** Reload the dashboard page when idle. Confirm an old reply does NOT flash up on load (the freshness guard suppresses stale `/log` entries).

If any check fails, do not commit — debug using the superpowers:systematic-debugging skill.

- [ ] **Step 4: Commit**

```bash
git add orchestrator/public/index.html
git commit -m "feat(dashboard): show JARVIS reply text on the orb until next wake

Render the spoken reply (already on the client via /log) into the orb
caption in amber, hold it past the orb's settle animation, and clear it
when the next wake cycle begins. Frontend-only; no backend changes.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done criteria

- A voice command's reply text appears on the orb in amber and stays until the next "hey jarvis."
- Typed commands and quick-switch buttons still display their replies (no regression).
- No stale reply flashes on page load.
- Single commit on branch `orb-reply-caption`, touching only `orchestrator/public/index.html`.
