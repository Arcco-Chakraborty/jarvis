import { matchSwitchCommand } from './rules.js';
import { matchPcCommand } from './pc.js';
import { matchVision, matchImplicitVision } from './vision.js';
import { matchAsk } from './ask.js';
import { matchConfirm } from './confirm.js';
import { geminiClassify } from './gemini.js';

// Cascade: switch -> pc -> vision -> ask -> confirm -> Gemini.
// Confirm sits AFTER pc so phrases like "confirm" only fire when nothing else
// did; pending-shell handling lives in the server.
export async function parseWithSource(text, vocab, classify = geminiClassify) {
  const s = matchSwitchCommand(text, vocab);
  if (s) return { intent: s, via: 'rules' };
  const p = matchPcCommand(text, vocab);
  if (p) return { intent: p, via: 'rules' };
  const vi = matchVision(text);
  if (vi) return { intent: vi, via: 'rules' };
  const ivi = matchImplicitVision(text);
  if (ivi) return { intent: ivi, via: 'rules' };
  const a = matchAsk(text);
  if (a) return { intent: a, via: 'rules' };
  const c = matchConfirm(text);
  if (c) return { intent: c, via: 'rules' };
  const g = await classify(text, vocab);
  return { intent: g, via: g ? 'gemini' : null };
}

// Intent only (back-compat).
export async function parse(text, vocab, classify = geminiClassify) {
  return (await parseWithSource(text, vocab, classify)).intent;
}

// The offline cascade only (switch -> pc -> vision -> ask -> confirm), no Gemini. Used
// for compound-command splitting where we don't want a Gemini call per clause.
export function parseLocal(text, vocab) {
  return (
    matchSwitchCommand(text, vocab) ||
    matchPcCommand(text, vocab) ||
    matchVision(text) ||
    matchImplicitVision(text) ||
    matchAsk(text) ||
    matchConfirm(text) ||
    null
  );
}
