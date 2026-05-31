// Knowledge answers in the Stark-JARVIS voice. One Gemini call, warm temperature,
// concise spoken output. Never throws; degrades to an in-character apology.
import { config } from '../config.js';
import { callGemini } from './gemini-client.js';

const PERSONA = [
  "You are JARVIS, Tony Stark's AI assistant.",
  'Answer the user\'s question in 2 to 4 spoken sentences: technically precise, concise, and dryly witty.',
  'Plain text only — no markdown, no bullet lists — it will be read aloud by text-to-speech.',
  "Address the user as 'sir' at most once, and only when it feels natural.",
].join(' ');

const OFFLINE = "I'm afraid my knowledge base is offline at the moment, sir.";
const FAILED = "My apologies, sir — I can't reach my knowledge base right now.";

export function makeKnowledge({
  keys,
  apiKey,
  fetchFn,
  model = 'gemini-2.5-flash',
  timeoutMs = 9000,
} = {}) {
  const keyList = keys ?? (apiKey ? [apiKey] : config.geminiApiKeys);
  return {
    async answer(query) {
      const q = String(query ?? '').trim();
      if (!keyList || keyList.length === 0) return { ok: true, speak: OFFLINE };
      const body = {
        systemInstruction: { parts: [{ text: PERSONA }] },
        contents: [{ parts: [{ text: q }] }],
        generationConfig: { temperature: 0.7 },
      };
      const data = await callGemini({ model, body, timeoutMs, fetchFn, keys: keyList });
      if (!data) return { ok: true, speak: FAILED };
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) return { ok: true, speak: FAILED };
      return { ok: true, speak: String(raw).trim() };
    },
  };
}
