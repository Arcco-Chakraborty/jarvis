// Local matcher for spoken knowledge questions -> { domain:'ask', query }.
// Deliberately a small explicit trigger set so it never swallows control
// commands (which are matched earlier in the cascade anyway). Questions
// phrased without a trigger still get caught by the Gemini brain.

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/^jarvis,?\s+/, '')
    .replace(/[?.!,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TRIGGERS = [
  /^find out about\s+(.+)$/,
  /^tell me about\s+(.+)$/,
  /^what(?:'s| is| are)\s+(.+)$/,
  /^who(?:'s| is| are)\s+(.+)$/,
];

export function matchAsk(text) {
  const norm = normalize(text);
  if (!norm) return null;
  for (const re of TRIGGERS) {
    const m = norm.match(re);
    if (m && m[1].trim()) return { domain: 'ask', query: m[1].trim() };
  }
  return null;
}
