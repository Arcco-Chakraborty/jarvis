// Pure rule matcher for the PC domain. Returns one of:
//   { domain:'pc', action:'open_app',  target }
//   { domain:'pc', action:'media',     op, arg? }   op: play_pause|next|prev|volume_up|volume_down|mute|set_volume
//   { domain:'pc', action:'window',    op, arg?, a?, b? }   op: focus|snap|minimize|close|split
//                                                            split uses { a, b }; others use { arg? }
//   { domain:'pc', action:'shell',     target }     (server wraps this in a confirmation prompt)

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/^jarvis,?\s+/, '')
    .replace(/[?.!,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUM_WORDS = {
  zero: 0, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

function parseSpokenNumber(text) {
  const d = text.match(/\b(\d+)\b/);
  if (d) return parseInt(d[1], 10);
  // longest words first so "one hundred" wins over "hundred" alone (none here, but defensive)
  const keys = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (new RegExp(`\\b${k}\\b`).test(text)) return NUM_WORDS[k];
  }
  return null;
}

const MEDIA_FIXED = [
  [/^(?:play|resume)(?:\s+music)?$/,                     'play_pause'],
  [/^pause(?:\s+music)?$/,                               'play_pause'],
  [/^play\s*pause$/,                                     'play_pause'],
  [/^(?:next|skip)(?:\s+song)?$/,                        'next'],
  [/^(?:previous|previous\s+song|go\s+back)$/,           'prev'],
  [/^(?:volume\s+up|louder|turn\s+(?:it\s+)?up)$/,       'volume_up'],
  [/^(?:volume\s+down|quieter|turn\s+(?:it\s+)?down)$/,  'volume_down'],
  [/^(?:mute|unmute)$/,                                  'mute'],
  [/^stop(?:\s+(?:the\s+)?music|\s+playing)$/,          'stop_music'],
];
const SET_VOL = /^set\s+volume\s+to\s+(.+?)(?:\s+percent)?$/;

const WINDOW = [
  [/^focus\s+(.+)$/,                'focus',    'cap'],
  [/^snap\s+(left|right)$/,         'snap',     'cap'],
  [/^minimize(?:\s+window)?$/,      'minimize', null],
  [/^close(?:\s+window)?$/,         'close',    null],
];

// Strip a trailing "on (the) <known-pc>" -> { text, machine } (machine null if none).
// Trade-off: the suffix is stripped from the whole text before any routing, so local-only
// paths (window/search/split) also silently discard the machine — the "on the <pc>" suffix
// is still removed from their arg.  Accepted trade-off: a search query ending exactly in
// "on the <pcname>" would be truncated (e.g. "search on the desktop" with pcNames:['desktop']).
function stripMachine(text, pcNames) {
  for (const name of pcNames) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = String(text).match(new RegExp(`^(.+?)\\s+on\\s+(?:the\\s+)?${esc}$`));
    if (m) return { text: m[1].trim(), machine: name };
  }
  return { text, machine: null };
}

export function matchPcCommand(text, vocab = {}) {
  const raw = normalize(text);
  if (!raw) return null;
  const { text: norm, machine } = stripMachine(raw, vocab.pcNames ?? []);
  const withMachine = (intent) => (machine ? { ...intent, machine } : intent);

  // open|launch|start <app>
  const open = norm.match(/^(?:open|launch|start)\s+(.+)$/);
  if (open) {
    const target = open[1].replace(/^the\s+/, '').trim();
    if (target) return withMachine({ domain: 'pc', action: 'open_app', target });
  }

  // media
  for (const [re, op] of MEDIA_FIXED) {
    if (re.test(norm)) return withMachine({ domain: 'pc', action: 'media', op });
  }

  // play / put on / play me / i want to hear <query> -> music.play
  // (the bare "play"/"play music"/"pause" cases are caught by MEDIA_FIXED above as play_pause)
  const playQ = norm.match(/^(?:play(?:\s+me)?|put\s+on|i\s+want\s+to\s+hear)\s+(?!music$)(.+)$/);
  if (playQ) {
    return withMachine({ domain: 'pc', action: 'media', op: 'play_music', arg: playQ[1].trim() });
  }

  const sv = norm.match(SET_VOL);
  if (sv) {
    const n = parseSpokenNumber(sv[1]);
    if (n != null) return withMachine({ domain: 'pc', action: 'media', op: 'set_volume', arg: n });
  }

  // what's open -> list windows (local only — no machine)
  if (/^(?:what'?s open|what is open|what windows are open|what windows do i have(?: open)?|list (?:my )?windows)$/.test(norm)) {
    return { domain: 'pc', action: 'window', op: 'list' };
  }

  // window (local only — no machine)
  for (const [re, op, argFrom] of WINDOW) {
    const m = norm.match(re);
    if (m) {
      const intent = { domain: 'pc', action: 'window', op };
      if (argFrom === 'cap' && m[1]) intent.arg = m[1].trim();
      return intent;
    }
  }

  // search / look up <topic> -> browser.search (local only — no machine)
  const sQ = norm.match(/^(?:search(?:\s+(?:about|for))?|look\s+up)\s+(.+)$/);
  if (sQ) {
    const topic = sQ[1].trim();
    // reject single-word prepositions captured when the optional group was skipped
    if (topic && topic !== 'about' && topic !== 'for') {
      return { domain: 'pc', action: 'browser', op: 'search', arg: topic };
    }
  }

  // split <a> with <b> -> window.split (local only — no machine)
  const sp = norm.match(/^split\s+(.+?)\s+with\s+(.+)$/);
  if (sp) {
    const a = sp[1].replace(/^the\s+/, '').trim();
    const b = sp[2].replace(/^the\s+/, '').trim();
    if (a && b) return { domain: 'pc', action: 'window', op: 'split', a, b };
  }

  // type <text> -> send keystrokes (remote-only; router rejects without a machine)
  const typ = norm.match(/^type\s+(.+)$/);
  if (typ && typ[1].trim()) {
    return withMachine({ domain: 'pc', action: 'type', text: typ[1].trim() });
  }

  // shell recipe — "run <recipe>"
  const run = norm.match(/^run\s+(.+)$/);
  if (run && run[1].trim()) {
    return withMachine({ domain: 'pc', action: 'shell', target: run[1].trim() });
  }

  return null;
}
