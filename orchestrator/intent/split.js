// Splits a spoken utterance into ordered clauses on explicit sequencers.
// "and then" / "after that" / "then" / "and". Longer connectors first so
// "and then" wins over a bare "and". Whether multiple clauses are actually
// treated as a compound command is decided by the caller (it requires every
// clause to independently parse as a local command).
export function splitUtterance(text) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  return s
    .split(/\s+(?:and then|after that|then|and)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
}
