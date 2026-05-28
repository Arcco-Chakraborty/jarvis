import express from 'express';
import { pathToFileURL } from 'node:url';
import { config, assertEsp32Configured } from './config.js';
import { openRegistry } from './db/registry.js';
import { Esp32Switch } from './devices/esp32-switch.js';
import { parse } from './intent/index.js';
import { route } from './router.js';

// Pure factory — no network, no DB. Takes its dependencies so it is trivially testable.
// `onCommand(text)` resolves to { ok, speak, intent }.
export function buildApp({ esp32, onCommand }) {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  // Debug: current cached state of the smart switch (PROJECT.md §5.1).
  app.get('/state', (req, res) => {
    res.json({ ok: true, smartswitch: esp32.snapshot(), online: esp32.online });
  });

  // Typed command transcript -> action -> spoken response.
  app.post('/command', async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ ok: false, speak: "Sorry, I didn't catch that.", intent: null });
    }
    res.json(await onCommand(text));
  });

  return app;
}

// Composition root: seed registry, wire the real board, poll, build the command pipeline, listen.
export function main() {
  assertEsp32Configured();
  const registry = openRegistry();
  const board = registry.getBoard();
  const esp32 = new Esp32Switch({
    baseUrl: board.base_url,
    names: registry.getSwitchNamesByChannel(),
  });

  esp32.on('online', () => console.log('[esp32] online'));
  esp32.on('offline', (err) => console.warn('[esp32] offline:', err?.message ?? err));
  esp32.on('change', (e) =>
    console.log(`[esp32] external change: ${e.name} -> ${e.on ? 'on' : 'off'}`),
  );
  esp32.startPolling();

  const vocab = {
    deviceNames: registry.getSwitchNamesByChannel(),
    groupNames: registry.getGroupNames().filter((g) => g !== 'other'),
  };

  const onCommand = async (text) => {
    const intent = parse(text, vocab);
    if (!intent) {
      registry.logCommand({ raw_text: text, intent: null, ok: 0, detail: 'no match' });
      return { ok: false, speak: "Sorry, I didn't catch that.", intent: null };
    }
    const { ok, speak } = await route(intent, { board: esp32, registry });
    registry.logCommand({ raw_text: text, intent, ok: ok ? 1 : 0, detail: speak });
    return { ok, speak, intent };
  };

  buildApp({ esp32, onCommand }).listen(config.port, () => {
    console.log(`JARVIS orchestrator listening on http://localhost:${config.port}`);
  });
}

// Run main() only when executed directly (node server.js), never on import (tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
