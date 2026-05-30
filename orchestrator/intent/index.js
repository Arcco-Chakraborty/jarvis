import { matchSwitchCommand } from './rules.js';
import { matchPcCommand } from './pc.js';
import { geminiClassify } from './gemini.js';

// Parse + report which layer matched. Cascade: switch rules -> pc rules -> Gemini fallback.
export async function parseWithSource(text, vocab, classify = geminiClassify) {
  const s = matchSwitchCommand(text, vocab);
  if (s) return { intent: s, via: 'rules' };
  const p = matchPcCommand(text);
  if (p) return { intent: p, via: 'rules' };
  const g = await classify(text, vocab);
  return { intent: g, via: g ? 'gemini' : null };
}

// Intent only (back-compat).
export async function parse(text, vocab, classify = geminiClassify) {
  return (await parseWithSource(text, vocab, classify)).intent;
}
