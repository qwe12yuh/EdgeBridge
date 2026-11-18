import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { createDashboard } from '../src/dashboard.mjs';
import { deskflowLayout } from '../src/dashboard-layout.mjs';

test('mirroring an isolated two-screen topology changes only the reciprocal links', () => {
  const config = 'section: screens\n\tmac-peer:\n\twin-peer:\nend\n\nsection: links\n\tmac-peer:\n\t\tright = win-peer # peer\n\twin-peer:\n\t\tleft = mac-peer\nend\n';
  const original = deskflowLayout(config, 'mac-peer', 'win-peer');
  assert.equal(original.layout, 'mac-left');
  const mirrored = original.render('mac-right');
  assert.equal(mirrored, config.replace('right = win-peer', 'left = win-peer').replace('left = mac-peer', 'right = mac-peer'));
  assert.equal(deskflowLayout(mirrored, 'mac-peer', 'win-peer').render('mac-left'), config);
  assert.throws(() => deskflowLayout(config.replace('left = mac-peer', 'right = mac-peer'), 'mac-peer', 'win-peer'));
  assert.throws(() => deskflowLayout(config.replace('left = mac-peer', 'left = other-peer'), 'mac-peer', 'win-peer'));
});

test('the local control API rejects foreign pages and serializes start and stop', { timeout: 5000 }, async context => {
  let mode = 'stopped', layout = 'mac-left', operations = 0;
  const running = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const server = createDashboard({
    status: async () => ({ mode, layout }),
    start: async () => { operations++; entered.resolve(); await running.promise; mode = 'running'; },
    stop: async () => { operations++; mode = 'stopped'; },
    setLayout: async next => { operations++; layout = next; },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => { running.resolve(); server.close(); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const headers = { origin: base, 'x-edgebridge-control': '1' };
  const invalidHost = await new Promise((resolve, reject) => {
    const query = request({ host: '127.0.0.1', port, path: '/api/status', headers: { host: 'example.org' } },
      response => { response.resume(); resolve(response.statusCode); });
    query.on('error', reject);
    query.end();
  });
  assert.equal(invalidHost, 403);
  const denied = await fetch(base + '/api/start', { method: 'POST', headers: { ...headers, origin: 'https://example.org' } });
  assert.equal(denied.status, 403);
  const missingHeader = await fetch(base + '/api/start', { method: 'POST', headers: { origin: base } });
  assert.equal(missingHeader.status, 403);
  assert.equal(operations, 0);
  const start = fetch(base + '/api/start', { method: 'POST', headers });
  await entered.promise;
  assert.deepEqual(await (await fetch(base + '/api/status')).json(), { mode: 'starting' });
  assert.equal((await fetch(base + '/api/stop', { method: 'POST', headers })).status, 409);
  assert.equal((await fetch(base + '/api/layout/mac-right', { method: 'POST', headers })).status, 409);
  running.resolve();
  assert.deepEqual(await (await start).json(), { mode: 'running', layout: 'mac-left' });
  assert.deepEqual(await (await fetch(base + '/api/layout/mac-right', { method: 'POST', headers })).json(),
    { mode: 'running', layout: 'mac-right' });
  assert.equal((await fetch(base + '/api/layout/unknown', { method: 'POST', headers })).status, 404);
  assert.deepEqual(await (await fetch(base + '/api/stop', { method: 'POST', headers })).json(), { mode: 'stopped', layout: 'mac-right' });
  assert.equal(operations, 3);
});
