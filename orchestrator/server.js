import express from 'express';
import { pathToFileURL } from 'node:url';
import { config, assertEsp32Configured } from './config.js';
import { openRegistry } from './db/registry.js';
import { Esp32Switch } from './devices/esp32-switch.js';

// Pure factory — no network, no DB. Takes its dependencies so it is trivially testable.
export function buildApp({ esp32 }) {
  const app = express();

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  // Debug: current cached state of the smart switch (PROJECT.md §5.1).
  app.get('/state', (req, res) => {
    res.json({ ok: true, smartswitch: esp32.snapshot(), online: esp32.online });
  });

  return app;
}

// Composition root: seed the registry, wire the real board, poll, and listen (§5.1 boot).
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

  buildApp({ esp32 }).listen(config.port, () => {
    console.log(`JARVIS orchestrator listening on http://localhost:${config.port}`);
  });
}

// Run main() only when executed directly (node server.js), never on import (tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
