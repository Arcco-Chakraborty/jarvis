// Pure rule matcher for the PC domain.
// "open|launch|start <target>" -> { domain: 'pc', action: 'open_app', target }.
// Loose match: the allowlist lookup happens in the capability (apps.js), so a
// miss can produce a friendly "I don't know how to open <x>" instead of falling
// through to Gemini.

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/^jarvis,?\s+/, '')
    .replace(/[?.!,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchPcCommand(text) {
  const norm = normalize(text);
  if (!norm) return null;
  const m = norm.match(/^(?:open|launch|start)\s+(.+)$/);
  if (!m) return null;
  let target = m[1].trim();
  // strip a leading "the " — "open the settings" => target "settings"
  target = target.replace(/^the\s+/, '').trim();
  if (!target) return null;
  return { domain: 'pc', action: 'open_app', target };
}
