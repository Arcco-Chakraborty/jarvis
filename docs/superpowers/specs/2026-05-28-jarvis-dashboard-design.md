# JARVIS — Web Dashboard Design

**Date:** 2026-05-28
**Status:** Approved — ready for implementation planning
**Scope:** A minimal local web dashboard to control/observe the switches without curl. Pulled
forward from PROJECT.md's Phase 5 "status dashboard" as a test/control surface.
**Source of truth:** `PROJECT.md`. This adds a UI; it must not change the device/firmware rules
(principle 2: no broker; the dashboard is just a browser hitting the orchestrator over HTTP).

---

## 1. Goal

Open `http://localhost:3000/` in a browser and see every switch's live on/off state, toggle any
switch with a click, run group / all-off actions, and type a free-form command — all without curl.

**Acceptance:** with the orchestrator running, `GET /` serves the dashboard; clicking a switch flips
the real relay and the tile updates within ~2s; the group/all-off buttons work; the text box echoes
the spoken response. `npm test` stays green.

## 2. Decisions

| Decision | Choice |
|----------|--------|
| Hosting | Served by the orchestrator at `GET /` via `express.static` — one static file, no build step, no new deps |
| Stack | Vanilla HTML + CSS + JS inline in `orchestrator/public/index.html` |
| Button control | New direct endpoint **`POST /switch {target, action}`** (builds an intent, calls the existing `route()`, logs) — bypasses the text matcher for deterministic button semantics |
| Free-text box | Uses the existing **`POST /command {text}`** (so the matcher is still exercised) |
| Live state | Browser polls `GET /state` every ~1.5s |
| all_off | Safe (board has independent power); exposed as an "All Off" button |

## 3. New endpoint: `POST /switch`

```
POST /switch
  req:  { "target": "tubelight", "action": "on" | "off" }      // device or group target
        { "action": "all_off" }                                // no target
  res:  { ok, speak, intent }    // same shape as /command
  400:  if action is not one of on | off | all_off
```

Handled by an injected `onSwitch({target, action})` (composed in `main()`), which:
- `all_off` → intent `{domain:'switch', action:'all_off'}`
- `on`/`off` with a **known** target (device name or group name) → intent `{domain:'switch', action, target}`
- otherwise → `{ ok:false, speak:"I don't know how to do that.", intent:null }`

then routes + logs via the shared `runIntent` helper (see §5).

## 4. `server.js` (`buildApp`) changes

`buildApp({ esp32, onCommand, onSwitch })`:
- `app.use(express.json())` (already there)
- `app.use(express.static(<orchestrator/public>))` — serves `index.html` at `GET /`; non-file paths
  (`/health`, `/state`, `/command`, `/switch`) fall through to their routes.
- `GET /health`, `GET /state`, `POST /command` — unchanged.
- `POST /switch`: validate `action ∈ {on, off, all_off}` (else 400), then `res.json(await onSwitch(req.body))`.

`buildApp` stays thin and testable: `onCommand` and `onSwitch` are injected.

## 5. `main()` composition

Refactor so routing+logging is shared:

```
const runIntent = async (intent, rawText) => {
  const { ok, speak } = await route(intent, { board: esp32, registry });
  registry.logCommand({ raw_text: rawText, intent, ok: ok ? 1 : 0, detail: speak });
  return { ok, speak, intent };
};

const onCommand = async (text) => {
  const intent = parse(text, vocab);
  if (!intent) {
    registry.logCommand({ raw_text: text, intent: null, ok: 0, detail: 'no match' });
    return { ok: false, speak: "Sorry, I didn't catch that.", intent: null };
  }
  return runIntent(intent, text);
};

const knownTargets = new Set([...vocab.deviceNames, ...registry.getGroupNames()]);
const onSwitch = async ({ target, action } = {}) => {
  let intent;
  if (action === 'all_off') intent = { domain: 'switch', action: 'all_off' };
  else if ((action === 'on' || action === 'off') && knownTargets.has(target)) {
    intent = { domain: 'switch', action, target };
  } else {
    return { ok: false, speak: "I don't know how to do that.", intent: null };
  }
  return runIntent(intent, `[ui] ${action}${target ? ' ' + target : ''}`);
};

buildApp({ esp32, onCommand, onSwitch }).listen(config.port, ...);
```

(`vocab` already built in `main()`; `knownTargets` includes the 8 device names + all group names.)

## 6. The dashboard page (`orchestrator/public/index.html`)

Single file, vanilla JS. On load and every ~1500ms it `fetch('/state')` and renders:

- **Header:** "JARVIS" + an online/offline dot from `state.online`.
- **Switch tiles** (one per `state.smartswitch` entry): the name + current state (color/label). Clicking
  a tile sends `POST /switch {target:<name>, action: <opposite of current>}`. Tiles disabled while
  `online` is false.
- **Group row:** `[Lights On] [Lights Off] [Fans On] [Fans Off] [All Off]` → `POST /switch`
  (`{target:'lights',action:'on'}`, …, `{action:'all_off'}`).
- **Command box:** text input + Send → `POST /command {text}`.
- **Status line:** shows the `speak` from the most recent action.

Layout sketch:
```
JARVIS                                        ● online
 Fan 1 [on]  Fan 2 [off]  Tubelight [on]  Spotlight [off]
 RGB Light [off]  Night Light [on]  Socket [on]  Spare [off]
 Groups: [Lights On][Lights Off] [Fans On][Fans Off] [All Off]
 Command: [ turn off the tubelight        ] [Send]
 ▸ "Tubelight is off."
```

After any action the page refreshes state immediately (re-fetch `/state`) so tiles reflect the change
without waiting for the next poll.

## 7. Testing

- **`server.test.js`** (additions):
  - `GET /` returns 200 and HTML containing the marker text `JARVIS`.
  - `POST /switch` with an injected `onSwitch` stub returns the stub's JSON.
  - `POST /switch` with an invalid `action` returns 400.
  - Existing `/health`, `/state`, `/command` tests stay green (now passing `onSwitch` where needed; the
    health/state tests don't need it).
- The button/poll **UI behavior is verified manually in a browser** — the agent cannot drive a browser,
  so it will curl-verify `GET /` + `POST /switch`, then the user confirms the live UI.

## 8. Out of scope

Auth, HTTPS, mobile-optimized styling, multi-board support, the `pc` domain, history/logs view,
websockets/live-push (polling is fine). No changes to the ESP32 firmware or its standalone UI.
