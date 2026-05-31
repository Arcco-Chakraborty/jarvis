import { config } from '../config.js';

const SWITCH_ACTIONS = new Set(['on', 'off', 'all_off', 'all_on', 'status', 'keep_only']);

function buildPrompt(text, vocab) {
  const devices = (vocab?.deviceNames ?? []).join(', ');
  const groups = (vocab?.groupNames ?? []).join(', ');
  const apps = (vocab?.appNames ?? []).join(', ');
  return [
    'You are the intent router for a voice assistant. Map the command to ONE JSON object. Respond with ONLY JSON, no prose.',
    'Choose the best match from these shapes:',
    '- Lights/fans/socket on or off: {"domain":"switch","action":"on|off","target":"<device or group>"}.',
    '- Everything off / everything on: {"domain":"switch","action":"all_off"} or {"domain":"switch","action":"all_on"}.',
    '- One device state question: {"domain":"switch","action":"status","target":"<device>"}.',
    '- Keep one on, rest off: {"domain":"switch","action":"keep_only","target":"<device or group>"}.',
    '- Launch an application: {"domain":"pc","action":"open_app","target":"<one of the app names>"}.',
    '- Play a song: {"domain":"pc","action":"media","op":"play_music","arg":"<song or artist>"}.',
    '- Pause/resume music: {"domain":"pc","action":"media","op":"play_pause"}. Stop music: {"domain":"pc","action":"media","op":"stop_music"}.',
    '- Web search: {"domain":"pc","action":"browser","op":"search","arg":"<query>"}.',
    '- Run a system task: {"domain":"pc","action":"shell","command":"<a single safe shell command>"} (it will be confirmed before running).',
    '- Answer a general question: {"domain":"ask","query":"<the question>"}.',
    '- Nothing fits: {"action":"none"}.',
    `Valid devices: ${devices}.`,
    `Valid groups: ${groups}.`,
    `Valid app names (use one of these exactly for open_app): ${apps}.`,
    'Infer the closest valid device/app for spelling mistakes and phonetic STT slips (e.g. "lites"->"lights", "vs code"->"visual studio code").',
    'The switch target and open_app target MUST be exactly one of the valid values listed. shell.command and ask.query are free text.',
    `Command: ${text}`,
  ].join('\n');
}

function validate(obj, vocab) {
  if (!obj || typeof obj !== 'object') return null;
  const devices = vocab?.deviceNames ?? [];
  const groups = vocab?.groupNames ?? [];
  const apps = vocab?.appNames ?? [];

  // ask
  if (obj.domain === 'ask') {
    return typeof obj.query === 'string' && obj.query.trim()
      ? { domain: 'ask', query: obj.query.trim() } : null;
  }

  // pc
  if (obj.domain === 'pc') {
    if (obj.action === 'open_app') {
      return typeof obj.target === 'string' && apps.includes(obj.target)
        ? { domain: 'pc', action: 'open_app', target: obj.target } : null;
    }
    if (obj.action === 'media') {
      if (obj.op === 'play_music') {
        return typeof obj.arg === 'string' && obj.arg.trim()
          ? { domain: 'pc', action: 'media', op: 'play_music', arg: obj.arg.trim() } : null;
      }
      if (obj.op === 'play_pause' || obj.op === 'stop_music') {
        return { domain: 'pc', action: 'media', op: obj.op };
      }
      return null;
    }
    if (obj.action === 'browser' && obj.op === 'search') {
      return typeof obj.arg === 'string' && obj.arg.trim()
        ? { domain: 'pc', action: 'browser', op: 'search', arg: obj.arg.trim() } : null;
    }
    if (obj.action === 'shell') {
      return typeof obj.command === 'string' && obj.command.trim()
        ? { domain: 'pc', action: 'shell', command: obj.command.trim() } : null;
    }
    return null;
  }

  // switch (default domain when action is a switch action)
  const action = obj.action;
  if (!SWITCH_ACTIONS.has(action)) return null;
  if (action === 'all_off') return { domain: 'switch', action: 'all_off' };
  if (action === 'all_on') return { domain: 'switch', action: 'all_on' };
  const target = obj.target;
  if (typeof target !== 'string') return null;
  if (action === 'status') {
    return devices.includes(target) ? { domain: 'switch', action: 'status', target } : null;
  }
  return devices.includes(target) || groups.includes(target)
    ? { domain: 'switch', action, target } : null;
}

// Classify a command with Gemini. Returns a validated intent or null, never throws.
export async function geminiClassify(text, vocab, {
  apiKey = config.geminiApiKey,
  fetchFn = globalThis.fetch,
  model = 'gemini-2.5-flash',
  timeoutMs = 8000,
} = {}) {
  if (!apiKey) return null;
  try {
    const res = await fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(text, vocab) }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    return validate(JSON.parse(raw), vocab);
  } catch {
    return null;
  }
}
