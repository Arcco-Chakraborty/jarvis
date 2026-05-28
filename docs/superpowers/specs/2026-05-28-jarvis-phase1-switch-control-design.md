# JARVIS — Phase 1 (Switch control, typed) Design

**Date:** 2026-05-28
**Status:** Approved — ready for implementation planning
**Scope:** Phase 1 only. Voice (Phase 2), PC domain (Phase 3), Gemini fallback (Phase 4) are out of scope.
**Source of truth:** `PROJECT.md` (§5.1 command API, §5.3 rule matcher, §7 command flow). If this
spec conflicts with PROJECT.md, PROJECT.md wins.

---

## 1. Goal

Let a human type a command "transcript" and have the orchestrator act on the real ESP32:

```
POST /command  {"text":"turn off the tubelight"}
  -> {"ok":true,"speak":"Tubelight is off.","intent":{"domain":"switch","action":"off","target":"tubelight"}}
```

No voice, no LLM. The rule matcher (switch domain only) parses the text, the router flips the
relay idempotently via the Phase-0 `Esp32Switch` adapter, every command is logged, and the
response carries the sentence the voice layer will eventually speak.

**Acceptance:** with the server running (Phase 0 boot, board live at `192.168.0.202`):
`curl -X POST localhost:3000/command -H 'content-type: application/json' -d '{"text":"turn off the tubelight"}'`
flips relay 2 and returns `ok:true` with `speak:"Tubelight is off."`. `npm test` green.

## 2. Locked decisions

| Decision | Choice |
|----------|--------|
| Command set | on/off (device), all_off, group on/off, status query |
| No `toggle` | Excluded — violates the idempotency principle (always `/set`) |
| Matcher strategy | Lightweight normalize + keyword/regex rules, vocab-aware (valid targets only) |
| Gemini fallback | Out of scope (Phase 4); unmatched input → graceful "didn't catch that" |
| Response shape | `{ok, speak, intent}` (PROJECT.md §5.1); `speak` is the sentence to say back |
| Spoken groups | `lights`, `fans` only — the schema's `other` group is **not** a voice target (avoids false matches on the word "other") |
| Status scope | Single device only ("is the tubelight on?"), not groups |

## 3. Components

### New

- **`orchestrator/intent/rules.js`** — `matchSwitchCommand(text, vocab) → intent | null`. Pure, no I/O.
- **`orchestrator/intent/index.js`** — `parse(text, vocab) → intent | null`. Phase 1 delegates to
  `matchSwitchCommand`. This is the seam where Phase 4 adds the Gemini fallback, so `server.js`
  never changes for that.
- **`orchestrator/router.js`** — `route(intent, {board, registry}) → {ok, speak}` (async). Performs
  board operations, group expansion, status reads, and builds the spoken sentence.

### Modified

- **`orchestrator/db/registry.js`** — add helpers:
  - `getAllSwitchNames() → string[]` (all 8 names; for matcher vocab)
  - `getGroupNames() → string[]` (distinct `group_name` values)
  - `getSwitchNamesByGroup(group) → string[]` (member names, ordered by channel)
  - `logCommand({raw_text, intent, ok, detail})` — insert one `command_log` row
- **`orchestrator/server.js`** — add `express.json()` and `POST /command`; `buildApp` takes an
  injected `onCommand(text)` so HTTP stays thin and testable. `main()` composes the real
  `onCommand` (parse → route → log) and builds the matcher vocab from the registry.

## 4. Intent contract

Unchanged from PROJECT.md §5.1:

```json
{ "domain": "switch", "action": "on | off | all_off | status", "target": "<device|group>" }
```

`target` is omitted for `all_off`. `params` is unused in Phase 1.

## 5. Rule matcher (`rules.js`)

**Vocab** (injected, built from the registry at boot):
`{ deviceNames: [8 switch names], groupNames: ["lights","fans"] }`.

**Normalization** of the input text, in order:
1. lowercase, trim
2. strip a leading wake word: `^jarvis,?\s+`
3. remove punctuation `? . ! ,`
4. collapse runs of whitespace to single spaces
5. remember whether the original contained `?` (signals a question)

**Target detection:** find every vocab target (device or group name) that occurs as a substring of
the normalized text; pick the **longest** match (so "night light" wins over any shorter token, and
"fan 1" is distinct from the "fans" group). Result is `{target, isGroup}` or none.

**Action + assembly** (first match wins):
1. **status** — if the normalized text starts with `is ` / `are `, or the original had `?`:
   - if a **device** target was found → `{switch, status, target}`
   - else → `null` (no group/all status in Phase 1)
2. otherwise pick on/off: `off` if the word `off` is present, else `on` if the word `on` is present,
   else → `null`.
3. with an on/off action:
   - if a target was found → `{switch, on|off, target}` (device or group; the router resolves which)
   - else if action is `off` and the text contains `all` or `everything` → `{switch, all_off}`
   - else → `null`

**Examples** (with the standard vocab):

| Input | Intent |
|-------|--------|
| `turn off the tubelight` | `{switch, off, tubelight}` |
| `turn on fan 1` | `{switch, on, "fan 1"}` |
| `lights off` | `{switch, off, lights}` |
| `fans on` | `{switch, on, fans}` |
| `all lights off` | `{switch, off, lights}` (group — **not** all_off) |
| `everything off` / `all off` | `{switch, all_off}` |
| `turn off the night light` | `{switch, off, "night light"}` |
| `is the tubelight on?` | `{switch, status, tubelight}` |
| `make me a sandwich` | `null` |

## 6. Router (`router.js`)

`route(intent, {board, registry})`, async. Board ops are wrapped in try/catch for the unreachable case.

- **on / off:**
  - group target (in `getGroupNames()`): for each `getSwitchNamesByGroup(target)` call
    `await board.set(name, action==='on')`; speak `"<Group> are <on|off>."` (e.g. "Lights are off.")
  - device target: `await board.set(target, action==='on')`; speak `"<Device> is <on|off>."`
    (e.g. "Tubelight is off."), capitalizing the first letter of the name.
  - returns `{ok:true, speak}`
- **all_off:** `await board.allOff()`; `{ok:true, speak:"Everything is off."}`
- **status:** `const s = board.isOn(target)` (cached, never throws):
  - `s === undefined` → `{ok:true, speak:"I haven't reached the smart switch yet."}`
  - else → `{ok:true, speak:"The <target> is <on|off>."}`
- **unreachable** (`board.set`/`allOff` throws) → `{ok:false, speak:"I couldn't reach the smart switch."}`

Group on/off issues one idempotent `set` per member; if any throws, the catch returns the
unreachable sentence.

## 7. Command pipeline & endpoint

`main()` builds:
```
vocab = { deviceNames: registry.getAllSwitchNames(),
          groupNames: registry.getGroupNames().filter(g => g !== 'other') }

async function onCommand(text) {
  const intent = parse(text, vocab);
  if (!intent) {
    registry.logCommand({ raw_text: text, intent: null, ok: 0, detail: 'no match' });
    return { ok: false, speak: "Sorry, I didn't catch that.", intent: null };
  }
  const { ok, speak } = await route(intent, { board, registry });
  registry.logCommand({ raw_text: text, intent, ok: ok ? 1 : 0, detail: speak });
  return { ok, speak, intent };
}
```

`buildApp({ esp32, onCommand })` adds `express.json()` and:
```
POST /command
  - if typeof body.text !== 'string' || !body.text.trim() -> 400 { ok:false, speak:"Sorry, I didn't catch that.", intent:null }
  - else -> 200 await onCommand(body.text)
```
`/health` and `/state` are unchanged.

## 8. Error handling summary

| Case | Response |
|------|----------|
| No rule match | `{ok:false, speak:"Sorry, I didn't catch that.", intent:null}` |
| Board unreachable | `{ok:false, speak:"I couldn't reach the smart switch."}` |
| Status before first poll | `{ok:true, speak:"I haven't reached the smart switch yet."}` |
| Missing/empty `text` | HTTP 400, `{ok:false, speak:"Sorry, I didn't catch that.", intent:null}` |

## 9. Logging

Every `POST /command` writes one `command_log` row: `ts` (ISO string), `raw_text`, `intent` (JSON or
null), `ok` (1/0), `detail` (the spoken sentence or "no match").

## 10. Testing (TDD)

Built-in `node:test`; no new dependencies.

- **`intent/rules.test.js`** — each row of the §5 examples table maps text → expected intent;
  gibberish → `null`; "all lights off" → group (not all_off); a multi-word device ("night light").
- **`router.test.js`** — a fake board (records `set` calls, flags `allOff`, returns canned `isOn`)
  plus a real in-memory registry (`openRegistry({dbPath:':memory:', esp32BaseUrl:'http://test'})`):
  device off calls `board.set('tubelight', false)` + correct sentence; group off expands to all four
  light members (ordered by channel); all_off calls `board.allOff()`; status on/off/undefined
  sentences; a throwing board yields the unreachable sentence.
- **`server.test.js`** — add: `POST /command` with an injected `onCommand` stub returns its result as
  JSON; missing `text` → 400. Existing `/health` and `/state` tests stay green.

## 11. Out of scope

Voice service (Phase 2), `pc` domain + music (Phase 3), Gemini fallback (Phase 4), `toggle`, group
or whole-board status queries, aliases table population (kept empty until a real alias is needed).
