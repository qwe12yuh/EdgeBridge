// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { collect, LIMITS } from '../src/files.mjs';
import { createReceiver, request, send } from '../src/transport.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('gesture context gates actual TLS uploads and native notification', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edgebridge-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=context-test',
    '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')], { stdio: 'ignore' });
  const cert = await fs.readFile(path.join(root, 'cert.pem')), key = await fs.readFile(path.join(root, 'key.pem'));
  const fixture = path.join(root, '普通图片.png'), bytes = randomBytes(65537);
  await fs.writeFile(fixture, bytes);
  const manifest = await collect([fixture]);
  const context = { gestureId: randomUUID(), generation: 37 };
  let count = 0;
  async function harness(options) {
    const token = randomBytes(32).toString('hex'), inbox = path.join(root, `inbox-${count++}`);
    const server = await createReceiver({ cert, key, token, inbox, ...options });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
    return { inbox, peer: { baseURL: `https://127.0.0.1:${server.address().port}`, certificate: cert, token } };
  }
  async function staged(peer) {
    const { id } = await request(peer, '/offer', { body: { entries: manifest.entries, context } });
    for (const [index, file] of manifest.sources) await request(peer, `/session/${id}/file/${index}`, { file });
    return id;
  }
  await t.test('send passes context unchanged through offer and commit to native notification', async () => {
    const calls = [], notifications = [];
    const { peer } = await harness({
      validateContext: async (value, meta) => { calls.push({ value, phase: meta.phase }); assert.deepEqual(meta.entries, manifest.entries); },
      onReceived: (paths, value) => { notifications.push(value); return { copied: false }; },
    });
    const result = await send(peer, manifest, { context });
    assert.deepEqual(calls, [{ value: context, phase: 'offer' }, { value: context, phase: 'commit' }]);
    assert.deepEqual(notifications, [context]);
    assert.deepEqual(await fs.readFile(result.paths[0]), bytes);
    assert.deepEqual(await fs.readFile(fixture), bytes);
  });
  await t.test('invalid offer creates no staging session or native notification', async () => {
    let notified = false;
    const { peer, inbox } = await harness({ validateContext: async () => false, onReceived: () => { notified = true; } });
    await assert.rejects(send(peer, manifest, { context }), /context rejected/u);
    assert.deepEqual(await fs.readdir(inbox), []);
    assert.equal(notified, false);
  });
  await t.test('revocation before commit prevents notification and retains verified staged bytes', async () => {
    let authorized = true, notified = false;
    const { peer, inbox } = await harness({ validateContext: () => authorized, onReceived: () => { notified = true; } });
    const id = await staged(peer);
    authorized = false;
    await assert.rejects(request(peer, `/session/${id}/commit`, { body: {} }), /context rejected/u);
    await assert.rejects(request(peer, `/session/${id}/commit`, { body: {} }), /unavailable/u);
    assert.equal(notified, false);
    const folders = await fs.readdir(inbox);
    assert.equal(folders.length, 1);
    assert.deepEqual(await fs.readFile(path.join(inbox, folders[0], path.basename(fixture))), bytes);
    assert.deepEqual(await fs.readFile(fixture), bytes);
  });
  await t.test('asynchronous commit revocation cannot race another commit into notification', async () => {
    const entered = deferred(), gate = deferred(); let authorized = true, notified = 0;
    const { peer } = await harness({
      validateContext: async (_value, { phase }) => { if (phase === 'commit') { entered.resolve(); await gate.promise; } return authorized; },
      onReceived: () => { notified++; },
    });
    const id = await staged(peer);
    const first = request(peer, `/session/${id}/commit`, { body: {} });
    const firstRejected = assert.rejects(first, /context rejected/u);
    await entered.promise;
    await assert.rejects(request(peer, `/session/${id}/commit`, { body: {} }), /unavailable/u);
    authorized = false; gate.resolve();
    await firstRejected;
    assert.equal(notified, 0);
  });
  await t.test('valid async context and simultaneous commits notify native at most once', async () => {
    const entered = deferred(), gate = deferred(); let notified = 0;
    const { peer } = await harness({
      validateContext: async (value, { phase }) => { assert.deepEqual(value, context); if (phase === 'commit') { entered.resolve(); await gate.promise; } return true; },
      onReceived: (_paths, value) => { assert.deepEqual(value, context); notified++; },
    });
    const id = await staged(peer);
    const first = request(peer, `/session/${id}/commit`, { body: {} });
    await entered.promise;
    await assert.rejects(request(peer, `/session/${id}/commit`, { body: {} }), /unavailable/u);
    gate.resolve(); await first;
    assert.equal(notified, 1);
  });
  await t.test('pending asynchronous offers count toward the session admission limit', async () => {
    const gate = deferred(), admitted = deferred(); let calls = 0;
    const { peer } = await harness({ validateContext: async () => { if (++calls === LIMITS.sessions) admitted.resolve(); await gate.promise; } });
    // Attach rejection handlers immediately so deliberately rejected offers never go unhandled.
    const results = Promise.allSettled(Array.from({ length: LIMITS.sessions + 3 }, () => request(peer, '/offer', { body: { entries: manifest.entries, context } })));
    await admitted.promise; gate.resolve();
    const outcomes = await results;
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, LIMITS.sessions);
    assert.equal(outcomes.filter(r => r.status === 'rejected').length, 3);
    assert.equal(calls, LIMITS.sessions);
  });
});
