// Local matcher for "look at this" style vision requests ->
// { domain:'vision', source:'camera'|'screen', query }. Sits before the ask
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
  /^look at (?:this|that)\b\s*(.*)$/,                              // camera
  /^look at (?:my |the )?(?:desk|camera|webcam)\b\s*(.*)$/,       // camera
  /^what am i holding\b\s*(.*)$/,                                  // camera
  /^what(?:'s| is)?\s+(?:this|that)\b\s*(.*)$/,                    // camera
  /^what(?:'s| is)?\s+on (?:my |the )?desk\b\s*(.*)$/,             // camera
  /^describe (?:this|that|what you see)\b\s*(.*)$/,                // camera
  /^what do you see\b\s*(.*)$/,                                    // camera
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
      return { domain: 'vision', source: isScreen(norm) ? 'screen' : 'camera', query };
    }
  }
  return null;
}
