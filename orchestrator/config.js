// Central config, populated from the environment (loaded via `node --env-file=.env`).
// No secrets or device IPs are hardcoded here — real values live in .env (gitignored).
export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? 'orchestrator/db/jarvis.db',
  esp32: {
    baseUrl: process.env.ESP32_BASE_URL, // required at boot (see assertEsp32Configured)
  },
  pcAgentToken: process.env.PC_AGENT_TOKEN ?? '', // unused until Phase 3
  geminiApiKey: process.env.GEMINI_API_KEY ?? '', // unused until Phase 4
};

// Fail fast at boot if the board URL is missing. Pure + injectable so it's testable.
export function assertEsp32Configured(cfg = config) {
  if (!cfg.esp32 || !cfg.esp32.baseUrl) {
    throw new Error('ESP32_BASE_URL is required — set it in .env (see .env.example)');
  }
}
