// Vision answers in the Stark-JARVIS voice. One multimodal Gemini call (text +
// inline image) routed through the rotating callGemini. Never throws.
import { config } from '../config.js';
import { callGemini } from './gemini-client.js';

const PERSONA = [
  "You are JARVIS, Tony Stark's AI assistant, looking at an image the user is showing you.",
  'Answer their question about the image in 1 to 3 spoken sentences: precise, concise, dryly witty.',
  'Plain text only — no markdown — it will be read aloud. Address the user as "sir" at most once.',
].join(' ');

const OFFLINE = "I'm afraid my eyes are offline at the moment, sir.";
const FAILED = "My apologies, sir — I couldn't make sense of what I'm seeing.";

export function makeVisionAnswer({
  keys,
  apiKey,
  fetchFn,
  model = 'gemini-2.5-flash',
  timeoutMs = 12000,
} = {}) {
  const keyList = keys ?? (apiKey ? [apiKey] : config.geminiApiKeys);
  return {
    async describe(query, data, mime) {
      if (!keyList || keyList.length === 0) return { ok: true, speak: OFFLINE };
      const body = {
        systemInstruction: { parts: [{ text: PERSONA }] },
        contents: [{ parts: [
          { text: String(query ?? '').trim() || 'What do you see?' },
          { inlineData: { mimeType: mime, data } },
        ] }],
        generationConfig: { temperature: 0.4 },
      };
      const res = await callGemini({ model, body, timeoutMs, fetchFn, keys: keyList });
      if (!res) return { ok: true, speak: FAILED };
      const raw = res?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) return { ok: true, speak: FAILED };
      return { ok: true, speak: String(raw).trim() };
    },
  };
}
