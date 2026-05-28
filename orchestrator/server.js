import express from 'express';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, assertEsp32Configured } from './config.js';
import { openRegistry } from './db/registry.js';
import { Esp32Switch } from './devices/esp32-switch.js';
import { parseWithSource } from './intent/index.js';
import { route } from './router.js';
import { createTelemetry } from './telemetry.js';

// Pure factory — no network, no DB. Dependencies injected for testability.
// onCommand(text) and onSwitch({target, action}) each resolve to { ok, speak, intent }.
export function buildApp({ esp32, onCommand, onSwitch, telemetry }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(import.meta.dirname, 'public')));

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/state', (req, res) => {
    res.json({ ok: true, smartswitch: esp32.snapshot(), online: esp32.online });
  });

  // Free-text transcript -> NL pipeline.
  app.post('/command', async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ ok: false, speak: "Sorry, I didn't catch that.", intent: null });
    }
    res.json(await onCommand(text));
  });

  // Direct, structured control for the dashboard buttons (bypasses the text matcher).
  app.post('/switch', async (req, res) => {
    const { action } = req.body ?? {};
    if (action !== 'on' && action !== 'off' && action !== 'all_off') {
      return res.status(400).json({ ok: false, speak: 'Bad request.', intent: null });
    }
    res.json(await onSwitch(req.body));
  });

  // Voice telemetry: voice service reports events here; dashboard reads /voice and /log.
  app.post('/voice/event', (req, res) => {
    telemetry?.recordVoiceEvent(req.body ?? {});
    res.json({ ok: true });
  });
  app.get('/voice', (req, res) => {
    res.json(telemetry ? telemetry.voiceSnapshot() : {});
  });
  app.get('/log', (req, res) => {
    res.json({ commands: telemetry ? telemetry.recentCommands(50) : [] });
  });

  return app;
}

// Composition root: seed registry, wire the board, poll, build pipelines, listen.
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
  const knownTargets = new Set([...vocab.deviceNames, ...registry.getGroupNames()]);

  const telemetry = createTelemetry();

  const runIntent = async (intent, rawText, via) => {
    const { ok, speak } = await route(intent, { board: esp32, registry });
    registry.logCommand({ raw_text: rawText, intent, ok: ok ? 1 : 0, detail: speak });
    telemetry.recordCommand({ text: rawText, intent, via, ok, speak });
    return { ok, speak, intent, via };
  };

  const onCommand = async (text) => {
    const { intent, via } = await parseWithSource(text, vocab);
    if (!intent) {
      registry.logCommand({ raw_text: text, intent: null, ok: 0, detail: 'no match' });
      telemetry.recordCommand({ text, intent: null, via: null, ok: false, speak: "Sorry, I didn't catch that." });
      return { ok: false, speak: "Sorry, I didn't catch that.", intent: null, via: null };
    }
    return runIntent(intent, text, via);
  };

  const onSwitch = async ({ target, action } = {}) => {
    let intent;
    if (action === 'all_off') intent = { domain: 'switch', action: 'all_off' };
    else if ((action === 'on' || action === 'off') && knownTargets.has(target)) {
      intent = { domain: 'switch', action, target };
    } else {
      return { ok: false, speak: "I don't know how to do that.", intent: null, via: 'ui' };
    }
    return runIntent(intent, `[ui] ${action}${target ? ' ' + target : ''}`, 'ui');
  };

  buildApp({ esp32, onCommand, onSwitch, telemetry }).listen(config.port, () => {
    console.log(`JARVIS orchestrator listening on http://localhost:${config.port}`);
  });
}

// Run main() only when executed directly (node server.js), never on import (tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
