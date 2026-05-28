import { matchSwitchCommand } from './rules.js';

// Parse a command transcript into an intent. Phase 1: rule matcher only.
// Phase 4 will add a Gemini fallback here when matchSwitchCommand returns null.
export function parse(text, vocab) {
  return matchSwitchCommand(text, vocab);
}
