// Pure rule-based matcher for the switch domain. No I/O.
// vocab = { deviceNames: string[], groupNames: string[] }.

// Standard two-row Levenshtein edit distance.
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/^jarvis,?\s+/, '')
    .replace(/[?.!,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Max edit distance for a fuzzy DEVICE match by joined-name length.
// <=4 requires exact (avoids ambiguous flips like fan 1/fan 2); longer tolerate 1-2.
function maxDist(len) {
  return len <= 4 ? 0 : Math.min(2, Math.floor(len / 4));
}

// Resolve a target from the normalized tokens.
// Groups: exact only. Devices: fuzzy within maxDist. An exact group beats a fuzzy device.
function findTarget(tokens, deviceNames, groupNames) {
  const windows = [];
  for (let i = 0; i < tokens.length; i++) {
    windows.push(tokens[i]);
    if (i + 1 < tokens.length) windows.push(tokens[i] + tokens[i + 1]);
  }

  for (const g of groupNames) {
    if (windows.includes(g.replace(/\s+/g, ''))) return g;
  }

  let best = null; // { name, dist, tjLen }
  for (const name of deviceNames) {
    const tj = name.replace(/\s+/g, '');
    let min = Infinity;
    for (const w of windows) {
      const d = levenshtein(w, tj);
      if (d < min) min = d;
    }
    if (min <= maxDist(tj.length)) {
      if (best === null || min < best.dist || (min === best.dist && tj.length > best.tjLen)) {
        best = { name, dist: min, tjLen: tj.length };
      }
    }
  }
  return best ? best.name : null;
}

export function matchSwitchCommand(text, vocab) {
  const raw = String(text ?? '');
  const isQuestion = raw.includes('?');
  const norm = normalize(raw);
  if (!norm) return null;

  const { deviceNames = [], groupNames = [] } = vocab ?? {};
  const tokens = norm.split(' ').filter(Boolean);
  const target = findTarget(tokens, deviceNames, groupNames);

  if (
    target &&
    /\bon\b/.test(norm) &&
    /\b(rest|others|everything else|all else|other ones)\b/.test(norm) &&
    (/\boff\b/.test(norm) || /\bturn of\b/.test(norm))
  ) {
    return { domain: 'switch', action: 'keep_only', target };
  }

  // Status query (question form) — single device only.
  if (isQuestion || /^(is|are)\b/.test(norm)) {
    if (target && deviceNames.includes(target)) {
      return { domain: 'switch', action: 'status', target };
    }
    return null;
  }

  // Action: off (incl. "turn of" STT slip + synonyms) / on. Short words kept exact (no fuzzing).
  let action = null;
  if (
    /\boff\b/.test(norm) ||
    /\bturn of\b/.test(norm) ||
    tokens.some((t) => t === 'shut' || t === 'kill' || t === 'cut')
  ) {
    action = 'off';
  } else if (/\bon\b/.test(norm)) {
    action = 'on';
  }
  if (!action) return null;

  if (target) return { domain: 'switch', action, target };

  // all_off: off + no specific target + a global word (fuzzy<=1 on the long word "everything").
  if (action === 'off' && (/\ball\b/.test(norm) || tokens.some((t) => levenshtein(t, 'everything') <= 1))) {
    return { domain: 'switch', action: 'all_off' };
  }
  return null;
}
