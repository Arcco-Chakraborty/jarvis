// JARVIS PC agent — a tiny dependency-free Node http server. Capabilities are
// injected; /run is bearer-authenticated. Returns { ok, detail } JSON.
import http from 'node:http';

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// Returns an async (req,res) handler. Pure + injectable for tests.
export function makeAgent({ capabilities = [], token = '' } = {}) {
  const byName = new Map(capabilities.map((c) => [c.name, c]));
  return async function handler(req, res) {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true, capabilities: [...byName.keys()] });
      }
      if (req.method === 'POST' && req.url === '/run') {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${token}`) return send(res, 401, { ok: false, detail: 'unauthorized' });
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch { return send(res, 400, { ok: false, detail: 'bad json' }); }
        const cap = byName.get(body.capability);
        const action = cap?.actions?.[body.action];
        if (typeof action !== 'function') return send(res, 200, { ok: false, detail: 'unknown capability/action' });
        const result = await action(body.params || {});
        return send(res, 200, { ok: !!result?.ok, detail: result?.detail ?? '' });
      }
      return send(res, 404, { ok: false, detail: 'not found' });
    } catch {
      return send(res, 500, { ok: false, detail: 'agent error' });
    }
  };
}

export function start({ capabilities, token, port = Number(process.env.PORT ?? 7000) } = {}) {
  const server = http.createServer(makeAgent({ capabilities, token }));
  server.listen(port, () => console.log(`JARVIS PC agent on :${port} — capabilities: ${capabilities.map((c) => c.name).join(', ')}`));
  return server;
}
