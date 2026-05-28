// esp32-switch.js
// Orchestrator-side adapter for the 8-channel ESP32 smart switch.
//
// Talks to the existing firmware over plain HTTP (port 80) — no firmware
// changes, "independent mode" untouched. The orchestrator is just another
// client on the LAN, exactly what the device was built for.
//
// Firmware API used:
//   GET /state            -> { states:[bool x8], ip }
//   GET /set?r=<i>&s=<0|1> -> { states:[bool x8], ip }   (idempotent)
//   GET /alloff           -> { states:[bool x8], ip }
//
// Requires Node 18+ (global fetch, AbortSignal.timeout). No dependencies.

import { EventEmitter } from 'node:events';

// Channel order is fixed by the firmware (relayPins / relayNames arrays).
const DEFAULT_NAMES = [
  'fan 1', 'fan 2', 'tubelight', 'spotlight',
  'rgb light', 'night light', 'socket', 'spare',
];

export class Esp32Switch extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {string}   opts.baseUrl   e.g. "http://192.168.1.42"
   * @param {string[]} [opts.names]   name per channel, index 0..7
   * @param {number}   [opts.pollMs]  state poll interval
   * @param {number}   [opts.timeoutMs] per-request timeout
   */
  constructor({ baseUrl, names = DEFAULT_NAMES, pollMs = 4000, timeoutMs = 2500 }) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.names = names;
    this.index = new Map(names.map((n, i) => [n.toLowerCase().trim(), i]));
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.states = null;   // [bool x8] once reached; null until first contact
    this.online = false;
    this._timer = null;
  }

  async _get(path) {
    const res = await fetch(this.baseUrl + path, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`ESP32 ${path} returned HTTP ${res.status}`);
    return res.json();
  }

  /** Spoken/registry name -> channel index. Throws on unknown name. */
  resolve(name) {
    const i = this.index.get(String(name).toLowerCase().trim());
    if (i === undefined) throw new Error(`Unknown switch: "${name}"`);
    return i;
  }

  /**
   * Set one relay to an explicit state. Idempotent — always use this for
   * voice commands ("turn off X" -> set(X, false)). Returns the new state.
   * Throws if the device is unreachable, so the caller can tell the user.
   */
  async set(name, on) {
    const data = await this._get(`/set?r=${this.resolve(name)}&s=${on ? 1 : 0}`);
    this._apply(data.states, false);
    return this.isOn(name);
  }

  /** Turn every relay off. */
  async allOff() {
    const data = await this._get('/alloff');
    this._apply(data.states, false);
  }

  /** Pull current state. Called by the poller; safe to call directly too. */
  async refresh() {
    try {
      const data = await this._get('/state');
      this._apply(data.states, true);
      if (!this.online) { this.online = true; this.emit('online'); }
    } catch (err) {
      if (this.online || this.states === null) {
        this.online = false;
        this.emit('offline', err);
      }
    }
  }

  /**
   * Instant, cached lookup — no network call. Returns true/false, or
   * undefined if the device hasn't been reached yet. Use this to answer
   * "is the tubelight on?" without waiting on the ESP32.
   */
  isOn(name) {
    return this.states ? this.states[this.resolve(name)] : undefined;
  }

  /** All channels as { name: bool }, or null if never reached. */
  snapshot() {
    if (!this.states) return null;
    return Object.fromEntries(this.names.map((n, i) => [n, this.states[i]]));
  }

  // emit=true only for poll-discovered changes, so a 'change' event always
  // means "something external flipped a relay" — commanded set()/allOff()
  // are silent because the caller already knows.
  _apply(states, emit) {
    if (!Array.isArray(states) || states.length !== this.names.length) return;
    const next = states.map(Boolean);
    const prev = this.states;
    this.states = next;
    if (emit && prev) {
      next.forEach((on, i) => {
        if (on !== prev[i]) this.emit('change', { index: i, name: this.names[i], on });
      });
    }
  }

  startPolling() {
    if (this._timer) return;
    this.refresh();
    this._timer = setInterval(() => this.refresh(), this.pollMs);
  }

  stopPolling() {
    clearInterval(this._timer);
    this._timer = null;
  }
}

// ── Usage in the orchestrator ───────────────────────────────────────────
//
// import { Esp32Switch } from './esp32-switch.js';
//
// const board = new Esp32Switch({ baseUrl: 'http://192.168.1.42' });
// board.startPolling();
// board.on('change',  e => console.log(`${e.name} -> ${e.on ? 'on' : 'off'}`));
// board.on('offline', () => console.warn('smart switch unreachable'));
//
// // from the intent handler:
// try {
//   await board.set('tubelight', false);   // "jarvis turn off tubelight"
//   speak('tubelight is off');
// } catch {
//   speak("I couldn't reach the smart switch");
// }
