import { matchSwitchCommand } from './rules.js';
import { geminiClassify } from './gemini.js';

// Parse + report which layer matched. Cascade: fuzzy rules (offline) -> Gemini fallback.
export async function parseWithSource(text, vocab, classify = geminiClassify) {
  const m = matchSwitchCommand(text, vocab);
  if (m) return { intent: m, via: 'rules' };
  const g = await classify(text, vocab);
  return { intent: g, via: g ? 'gemini' : null };
}

// Intent only (back-compat).
export async function parse(text, vocab, classify = geminiClassify) {
  return (await parseWithSource(text, vocab, classify)).intent;
}
