import { matchSwitchCommand } from './rules.js';
import { geminiClassify } from './gemini.js';

// Parse a command transcript into an intent.
// Cascade: fuzzy rule matcher (offline) -> Gemini fallback (only on a rules-miss).
export async function parse(text, vocab, classify = geminiClassify) {
  const m = matchSwitchCommand(text, vocab);
  if (m) return m;
  return await classify(text, vocab);
}
