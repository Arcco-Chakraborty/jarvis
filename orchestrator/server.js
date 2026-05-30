import express from 'express';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, assertEsp32Configured } from './config.js';
import { openRegistry } from './db/registry.js';
import { Esp32Switch } from './devices/esp32-switch.js';
import { parseWithSource } from './intent/index.js';
import { route } from './router.js';
import { createTelemetry } from './telemetry.js';

const WEATHER_LAT = process.env.WEATHER_LAT || '28.36';   // Pilani default
const WEATHER_LON = process.env.WEATHER_LON || '75.59';
const WEATHER_TTL_MS = 5 * 60 * 1000;

function weatherCodeLabel(code) {
  if (code === 0) return 'CLEAR';
  if (code <= 3) return 'PARTLY CLOUDY';
  if (code <= 48) return 'FOG';
  if (code <= 67) return 'DRIZZLE';
  if (code <= 77) return 'SNOW';
  if (code <= 82) return 'RAIN SHOWERS';
  if (code <= 86) return 'SNOW SHOWERS';
  if (code <= 99) return 'THUNDERSTORM';
  return 'UNKNOWN';
}

// Pure factory — no network, no DB. Dependencies injected for testability.
// onCommand(text) and onSwitch({target, action}) each resolve to { ok, speak, intent }.
export function buildApp({ esp32, onCommand, onSwitch, telemetry, vocab, weatherFetch = fetch, now = Date.now }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(import.meta.dirname, 'public')));

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  // OS vitals: cpu (1-min loadavg / cores), mem%, uptime, thermal (Linux only).
  app.get('/system', async (req, res) => {
    try {
      const cores = os.cpus().length;
      const load = os.loadavg();
      const cpu = Math.min(100, (load[0] / Math.max(cores, 1)) * 100);
      const total = os.totalmem();
      const free = os.freemem();
      const mem = ((total - free) / total) * 100;
      let therm = null;
      try {
        const raw = await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
        therm = parseInt(raw, 10) / 1000;
      } catch {}
      res.json({
        ok: true, cpu, mem, load, cores,
        uptime: Math.floor(os.uptime()),
        therm, host: os.hostname(), platform: os.platform(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Open-Meteo proxy with a 5-minute cache so the dashboard polling doesn't hammer it.
  let weatherCache = { at: 0, data: null };
  app.get('/weather', async (req, res) => {
    const t = now();
    if (weatherCache.data && t - weatherCache.at < WEATHER_TTL_MS) {
      return res.json(weatherCache.data);
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`;
    try {
      const r = await weatherFetch(url);
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const j = await r.json();
      const c = j.current ?? {};
      const data = {
        ok: true,
        temp: c.temperature_2m, humid: c.relative_humidity_2m,
        wind: c.wind_speed_10m, code: c.weather_code,
        cond: weatherCodeLabel(c.weather_code),
        lat: WEATHER_LAT, lon: WEATHER_LON,
      };
      weatherCache = { at: t, data };
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  app.get('/state', (req, res) => {
    res.json({ ok: true, smartswitch: esp32.snapshot(), online: esp32.online });
  });

  // Force a fresh poll of the board (skips the cache; dashboard "refresh" button hits this).
  app.post('/state/refresh', async (req, res) => {
    try {
      await esp32.refresh();
      res.json({ ok: true, smartswitch: esp32.snapshot(), online: esp32.online });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
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

  // Command vocabulary (device + group names) — the voice service builds its grammar from this.
  app.get('/vocab', (req, res) => {
    res.json(vocab ?? { deviceNames: [], groupNames: [] });
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

  buildApp({ esp32, onCommand, onSwitch, telemetry, vocab }).listen(config.port, () => {
    console.log(`JARVIS orchestrator listening on http://localhost:${config.port}`);
  });
}

// Run main() only when executed directly (node server.js), never on import (tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
