// Central config, populated from the environment (loaded via `node --env-file=.env`).
// No secrets or device IPs are hardcoded here — real values live in .env (gitignored).

// GEMINI_API_KEYS is a comma-separated list; falls back to a lone GEMINI_API_KEY.
export function parseGeminiKeys(env = process.env) {
  const list = String(env.GEMINI_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (list.length) return list;
  const single = String(env.GEMINI_API_KEY ?? '').trim();
  return single ? [single] : [];
}

// PC_AGENTS: comma-separated "name=baseUrl" pairs.
export function parsePcAgents(raw = process.env.PC_AGENTS) {
  return String(raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => { const i = p.indexOf('='); return i > 0 ? { name: p.slice(0, i).trim(), baseUrl: p.slice(i + 1).trim() } : null; })
    .filter((a) => a && a.name && a.baseUrl);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? 'orchestrator/db/jarvis.db',
  esp32: {
    baseUrl: process.env.ESP32_BASE_URL, // required at boot (see assertEsp32Configured)
  },
  pcAgentToken: process.env.PC_AGENT_TOKEN ?? '', // unused until Phase 3
  geminiApiKey: process.env.GEMINI_API_KEY ?? '', // unused until Phase 4
  geminiApiKeys: parseGeminiKeys(),
  phoneCameraUrl: process.env.PHONE_CAMERA_URL ?? '', // IP Webcam snapshot URL for vision
  pcAgents: parsePcAgents(),
};

// Fail fast at boot if the board URL is missing. Pure + injectable so it's testable.
export function assertEsp32Configured(cfg = config) {
  if (!cfg.esp32 || !cfg.esp32.baseUrl) {
    throw new Error('ESP32_BASE_URL is required — set it in .env (see .env.example)');
  }
}
