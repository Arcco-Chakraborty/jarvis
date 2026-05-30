import { matchSwitchCommand } from './rules.js';
import { matchPcCommand } from './pc.js';
import { matchConfirm } from './confirm.js';
import { geminiClassify } from './gemini.js';

// Cascade: switch -> pc -> confirm -> Gemini.
// Confirm sits AFTER pc so phrases like "confirm" only fire when nothing else
// did; pending-shell handling lives in the server.
export async function parseWithSource(text, vocab, classify = geminiClassify) {
  const s = matchSwitchCommand(text, vocab);
  if (s) return { intent: s, via: 'rules' };
  const p = matchPcCommand(text);
  if (p) return { intent: p, via: 'rules' };
  const c = matchConfirm(text);
  if (c) return { intent: c, via: 'rules' };
  const g = await classify(text, vocab);
  return { intent: g, via: g ? 'gemini' : null };
}

// Intent only (back-compat).
export async function parse(text, vocab, classify = geminiClassify) {
  return (await parseWithSource(text, vocab, classify)).intent;
}
