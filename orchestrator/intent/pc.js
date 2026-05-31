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

export function matchPcCommand(text) {
  const norm = normalize(text);
  if (!norm) return null;

  // open|launch|start <app>
  const open = norm.match(/^(?:open|launch|start)\s+(.+)$/);
  if (open) {
    const target = open[1].replace(/^the\s+/, '').trim();
    if (target) return { domain: 'pc', action: 'open_app', target };
  }

  // media
  for (const [re, op] of MEDIA_FIXED) {
    if (re.test(norm)) return { domain: 'pc', action: 'media', op };
  }

  // play <query> -> music.play (excludes literal "music" so play_pause keeps winning above)
  const playQ = norm.match(/^play\s+(?!music$)(.+)$/);
  if (playQ) {
    return { domain: 'pc', action: 'media', op: 'play_music', arg: playQ[1].trim() };
  }

  const sv = norm.match(SET_VOL);
  if (sv) {
    const n = parseSpokenNumber(sv[1]);
    if (n != null) return { domain: 'pc', action: 'media', op: 'set_volume', arg: n };
  }

  // window
  for (const [re, op, argFrom] of WINDOW) {
    const m = norm.match(re);
    if (m) {
      const intent = { domain: 'pc', action: 'window', op };
      if (argFrom === 'cap' && m[1]) intent.arg = m[1].trim();
      return intent;
    }
  }

  // search / look up <topic> -> browser.search
  const sQ = norm.match(/^(?:search(?:\s+(?:about|for))?|look\s+up)\s+(.+)$/);
  if (sQ) {
    const topic = sQ[1].trim();
    // reject single-word prepositions captured when the optional group was skipped
    if (topic && topic !== 'about' && topic !== 'for') {
      return { domain: 'pc', action: 'browser', op: 'search', arg: topic };
    }
  }

  // split <a> with <b> -> window.split (strip a leading "the " from each)
  const sp = norm.match(/^split\s+(.+?)\s+with\s+(.+)$/);
  if (sp) {
    const a = sp[1].replace(/^the\s+/, '').trim();
    const b = sp[2].replace(/^the\s+/, '').trim();
    if (a && b) return { domain: 'pc', action: 'window', op: 'split', a, b };
  }

  // shell recipe — "run <recipe>"
  const run = norm.match(/^run\s+(.+)$/);
  if (run && run[1].trim()) {
    return { domain: 'pc', action: 'shell', target: run[1].trim() };
  }

  return null;
}
