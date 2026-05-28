import { config } from '../config.js';

const VALID_ACTIONS = new Set(['on', 'off', 'all_off', 'status', 'keep_only']);

function buildPrompt(text, vocab) {
  const devices = (vocab?.deviceNames ?? []).join(', ');
  const groups = (vocab?.groupNames ?? []).join(', ');
  return [
    'You classify a smart-home switch command into strict JSON. Respond with ONLY a JSON object, no prose.',
    'Actions: on, off, all_off, status, keep_only.',
    `Valid device targets: ${devices}.`,
    `Valid group targets: ${groups}.`,
    'Infer the closest valid target for obvious spelling mistakes, phonetic spellings, and STT slips.',
    'Examples: "lites" means "lights"; "toob light" means "tubelight"; "soket" means "socket".',
    'For on/off: {"domain":"switch","action":"on|off","target":"<one valid device or group>"}.',
    'For a single-device state question: {"domain":"switch","action":"status","target":"<one valid device>"}.',
    'For keeping one device/group on and turning the rest off: {"domain":"switch","action":"keep_only","target":"<one valid device or group>"}.',
    'For turning everything off: {"domain":"switch","action":"all_off"} (no target).',
    'The target MUST be exactly one of the valid targets listed above.',
    'If the input is not a switch command, respond {"action":"none"}.',
    `Command: ${text}`,
  ].join('\n');
}

function validate(obj, vocab) {
  if (!obj || typeof obj !== 'object') return null;
  const action = obj.action;
  if (!VALID_ACTIONS.has(action)) return null;
  if (action === 'all_off') return { domain: 'switch', action: 'all_off' };

  const devices = vocab?.deviceNames ?? [];
  const groups = vocab?.groupNames ?? [];
  const target = obj.target;
  if (typeof target !== 'string') return null;

  if (action === 'status') {
    return devices.includes(target) ? { domain: 'switch', action: 'status', target } : null;
  }

  return devices.includes(target) || groups.includes(target)
    ? { domain: 'switch', action, target }
    : null;
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
