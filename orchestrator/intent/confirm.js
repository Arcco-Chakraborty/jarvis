// Tiny matcher for the confirmation that follows a shell prompt.
// "confirm" / "go ahead" / "do it" -> { domain:'confirm', action:'yes' }
// Deliberately NOT including bare "yes" / "okay" — too easy for the recognizer
// to emit those from noise. (The voice service handles "stop"/"cancel"/"never
// mind" locally as STOP sentinels.)

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/^jarvis,?\s+/, '')
    .replace(/[?.!,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const YES = new Set(['confirm', 'go ahead', 'do it', 'yes confirm', 'confirmed']);

export function matchConfirm(text) {
  const norm = normalize(text);
  if (!norm) return null;
  if (YES.has(norm)) return { domain: 'confirm', action: 'yes' };
  return null;
}
