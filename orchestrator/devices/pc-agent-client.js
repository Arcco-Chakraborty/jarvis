// Talks to a JARVIS PC agent over HTTP. POST /run with a bearer token.
// Returns { ok, detail }; never throws.
import { config } from '../config.js';

export function makePcAgentClient({ fetchFn = fetch, token = config.pcAgentToken } = {}) {
  return {
    async run(baseUrl, { capability, action, params } = {}) {
      try {
        const res = await fetchFn(`${baseUrl}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ capability, action, params }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { ok: false, detail: 'unreachable' };
        const data = await res.json();
        return { ok: !!data?.ok, detail: data?.detail ?? '' };
      } catch {
        return { ok: false, detail: 'unreachable' };
      }
    },
  };
}
