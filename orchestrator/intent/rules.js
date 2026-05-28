// Pure rule-based matcher for the switch domain. No I/O.
// `vocab` = { deviceNames: string[], groupNames: string[] } injected from the registry.

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/^jarvis,?\s+/, '')
    .replace(/[?.!,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whole-token containment, so "fans" never matches inside "fan 1" and vice versa.
// `needle` may contain spaces (e.g. "rgb light").
function containsTarget(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^| )${escaped}(?:$| )`).test(haystack);
}

function findTarget(norm, deviceNames, groupNames) {
  const candidates = [...deviceNames, ...groupNames]
    .filter((name) => containsTarget(norm, name))
    .sort((a, b) => b.length - a.length); // longest wins ("night light" over "light")
  return candidates[0] ?? null;
}

export function matchSwitchCommand(text, vocab) {
  const raw = String(text ?? '');
  const isQuestion = raw.includes('?');
  const norm = normalize(raw);
  if (!norm) return null;

  const { deviceNames = [], groupNames = [] } = vocab ?? {};
  const target = findTarget(norm, deviceNames, groupNames);

  // Status query (question form) — single device only.
  if (isQuestion || /^(is|are)\b/.test(norm)) {
    if (target && deviceNames.includes(target)) {
      return { domain: 'switch', action: 'status', target };
    }
    return null;
  }

  // on / off action (whole word).
  let action = null;
  if (/\boff\b/.test(norm)) action = 'off';
  else if (/\bon\b/.test(norm)) action = 'on';
  if (!action) return null;

  if (target) return { domain: 'switch', action, target };
  if (action === 'off' && /\b(all|everything)\b/.test(norm)) {
    return { domain: 'switch', action: 'all_off' };
  }
  return null;
}
