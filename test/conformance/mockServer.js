// Reference HTTP surface for conformance runs: POST /v1/decisions and GET /healthz over the reference engine.
// Test-only fault injection headers: x-ag-test-delay (ms), x-ag-test-fail (HTTP status).
import { createServer } from 'node:http';
import { SPEC_VERSION, decide } from '../../src/index.js';

const problem = (res, status, title, detail) => {
  res.writeHead(status, { 'content-type': 'application/problem+json', 'ag-spec-version': SPEC_VERSION });
  res.end(JSON.stringify({ type: `https://abuseguard.dev/problems/${title.toLowerCase().replace(/\s+/g, '-')}`, title, status, detail }));
};

export function startMockServer() {
  let seq = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', spec_version: SPEC_VERSION }));
    }
    if (req.method !== 'POST' || req.url !== '/v1/decisions') return problem(res, 404, 'Not Found', req.url);
    if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) return problem(res, 401, 'Unauthorized', 'missing bearer token');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const fail = Number(req.headers['x-ag-test-fail'] ?? 0), delay = Number(req.headers['x-ag-test-delay'] ?? 0);
      if (fail) return problem(res, fail, 'Injected Failure', 'x-ag-test-fail');
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return problem(res, 400, 'Invalid Request', 'body is not JSON'); }
      if (!input?.subject?.kind || !input.subject.id) return problem(res, 400, 'Invalid Request', 'subject.kind and subject.id are required');
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json', 'ag-spec-version': SPEC_VERSION });
        res.end(JSON.stringify({ decision_id: `dec_${++seq}`, ...decide(input) }));
      }, delay);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  })));
}
