// Local matcher for "look at this" style vision requests ->
// { domain:'vision', source:'phone'|'screen', query }. Sits before the ask
// matcher so "what is this" grabs an image instead of a knowledge lookup.

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/^jarvis,?\s+/, '')
    .replace(/[?.!,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const DEFAULT_QUERY = 'What do you see?';

// Each trigger captures an optional trailing question in group 1.
const TRIGGERS = [
  /^look at (?:my |the )?(?:screen|display|monitor)\b\s*(.*)$/,   // screen (explicit)
  /^what(?:'s| is)?\s+on (?:my |the )?(?:screen|display)\b\s*(.*)$/, // screen
  /^look at (?:this|that)\b\s*(.*)$/,                              // phone
  /^look at (?:my |the )?(?:desk|camera|webcam)\b\s*(.*)$/,       // phone
  /^look (?:at|through) (?:my |the )?phone\b\s*(.*)$/,            // phone (explicit)
  /^use (?:my |the )?phone(?: camera)?\b\s*(.*)$/,                // phone (explicit)
  /^what am i doing\b\s*(.*)$/,                                   // phone
  /^what am i holding\b\s*(.*)$/,                                  // phone
  /^what(?:'s| is)?\s+(?:this|that)\b\s*(.*)$/,                    // phone
  /^what(?:'s| is)?\s+on (?:my |the )?desk\b\s*(.*)$/,             // phone
  /^describe (?:this|that|what you see)\b\s*(.*)$/,                // phone
  /^what do you see\b\s*(.*)$/,                                    // phone
];

function isScreen(norm) {
  return /\b(screen|display|monitor)\b/.test(norm);
}

export function matchVision(text) {
  const norm = normalize(text);
  if (!norm) return null;
  for (const re of TRIGGERS) {
    const m = norm.match(re);
    if (m) {
      const query = (m[1] || '').trim() || DEFAULT_QUERY;
      return { domain: 'vision', source: isScreen(norm) ? 'screen' : 'phone', query };
    }
  }
  return null;
}

const DEMONSTRATIVE = /\b(this|that|these|those|here)\b/;
const BARE_HELP = /^(fix\b|what'?s wrong with\b|what is wrong with\b)/;

// Implicit vision: natural phrasing that points at something physical. Runs
// after explicit vision and before the knowledge matcher. Always the phone.
export function matchImplicitVision(text) {
  const norm = normalize(text);
  if (!norm) return null;
  if (DEMONSTRATIVE.test(norm) || BARE_HELP.test(norm)) {
    return { domain: 'vision', source: 'phone', query: norm, implicit: true };
  }
  return null;
}
