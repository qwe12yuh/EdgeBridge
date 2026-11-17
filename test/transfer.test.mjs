// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { collect, validateManifest, safeRelative } from '../src/files.mjs';
import { createReceiver, request, send } from '../src/transport.mjs';
import { cleanupStagedBatch, pruneStagedInbox } from '../src/gesture-files.mjs';
import { checkConfig } from '../src/config-check.mjs';

test('reject cross-platform traversal, reserved names and ambiguous trees', () => {
  for (const name of ['../x', '/x', 'C:/x', 'a\\b', 'a//b', 'CON.txt', 'a.', 'x/../z']) assert.throws(() => safeRelative(name), name);
  const f = name => ({ name, kind: 'file', size: 0, sha256: '0'.repeat(64) });
  assert.throws(() => validateManifest([f('A'), f('a')]));
  assert.throws(() => validateManifest([f('é'), f('e\u0301')]));
  assert.throws(() => validateManifest([f('a'), f('a/b')]));
  assert.throws(() => validateManifest([f('no-parent/a')]));
  assert.throws(() => validateManifest([{ ...f('a'), size: 1024 ** 3 + 1 }]));
});

test('TLS transfer verifies bytes, retains sources and refuses invalid peers/uploads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edgebridge-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test-only',
    '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')], { stdio: 'ignore' });
  const cert = await fs.readFile(path.join(root, 'cert.pem'));
  const key = await fs.readFile(path.join(root, 'key.pem'));
  const token = randomBytes(32).toString('hex'), inbox = path.join(root, 'inbox');
  const events = []; let nativeResult;
  const server = await createReceiver({ cert, key, token, inbox, onReceived: paths => { events.push(paths); return nativeResult; } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const peer = { baseURL: `https://127.0.0.1:${server.address().port}`, certificate: cert, token };
  await t.test('authorization is required', async () => {
    await assert.rejects(request({ ...peer, token: 'wrong' }, '/health'), /Unauthorized/u);
    assert.equal((await request(peer, '/health')).protocol, 1);
  });
  await t.test('a different certificate cannot be substituted', async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=untrusted',
      '-keyout', path.join(root, 'other-key.pem'), '-out', path.join(root, 'other-cert.pem')], { stdio: 'ignore' });
    await assert.rejects(request({ ...peer, certificate: await fs.readFile(path.join(root, 'other-cert.pem')) }, '/health'));
  });
  const source = path.join(root, '资料');
  await fs.mkdir(path.join(source, '空目录'), { recursive: true });
  const content = randomBytes(1024 * 1024 + 13);
  await fs.writeFile(path.join(source, '随机.bin'), content);
  await fs.writeFile(path.join(source, '空.txt'), '');
  const manifest = await collect([source]);
  let received;
  await t.test('Unicode, binary content, empty files and empty directories survive', async () => {
    received = (await send(peer, manifest)).paths[0];
    assert.deepEqual(await fs.readFile(path.join(received, '随机.bin')), content);
    assert.equal((await fs.stat(path.join(received, '空目录'))).isDirectory(), true);
    assert.equal((await fs.stat(path.join(received, '空.txt'))).size, 0);
    assert.deepEqual(await fs.readFile(path.join(source, '随机.bin')), content);
    assert.equal(events.length, 1);
  });
  await t.test('repeat delivery never overwrites an earlier destination', async () => {
    const next = (await send(peer, manifest)).paths[0];
    assert.notEqual(next, received);
    assert.deepEqual(await fs.readFile(path.join(received, '随机.bin')), content);
  });
  await t.test('corruption prevents commit and native notification', async () => {
    const { id } = await request(peer, '/offer', { body: { entries: manifest.entries } });
    const i = manifest.entries.findIndex(e => e.kind === 'file' && e.size > 0);
    const wrong = path.join(root, 'wrong.bin'); await fs.writeFile(wrong, Buffer.alloc(content.length));
    await assert.rejects(request(peer, `/session/${id}/file/${i}`, { file: wrong }), /Integrity mismatch/u);
    await assert.rejects(request(peer, `/session/${id}/commit`, { body: {} }), /Incomplete/u);
    assert.equal(events.length, 2);
  });
  await t.test('file transport success is not reported as a successful native drop', async () => {
    nativeResult = { copied: false, error: 'native drag cancelled' };
    const failedDrop = await send(peer, manifest);
    assert.equal(failedDrop.handoff.copied, false);
    assert.equal(failedDrop.handoff.error, 'native drag cancelled');
    assert.deepEqual(await fs.readFile(path.join(failedDrop.paths[0], '随机.bin')), content);
    nativeResult = { copied: true };
    assert.equal((await send(peer, manifest)).handoff.copied, true);
    nativeResult = undefined;
  });
  await t.test('shutdown can abort a request while the remote native helper is stalled', async () => {
    let notify;
    const arrived = new Promise(resolve => { notify = resolve; });
    const before = events.length;
    let release;
    nativeResult = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const result = send(peer, manifest, { signal: controller.signal });
    const rejected = assert.rejects(result, { name: 'AbortError' });
    const watcher = setInterval(() => { if (events.length > before) notify(); }, 5);
    try {
      await arrived;
      controller.abort();
      await rejected;
    } finally { clearInterval(watcher); release({ copied: false }); nativeResult = undefined; }
  });
  await t.test('symbolic links never expose files outside the selection', async () => {
    const link = path.join(root, 'secret-link'); await fs.symlink(path.join(root, 'key.pem'), link);
    await assert.rejects(collect([link]), /Symbolic/u);
  });
  await t.test('concurrent commits notify the native adapter at most once', async () => {
    const { id } = await request(peer, '/offer', { body: { entries: [{ name: '空文件夹', kind: 'directory' }] } });
    const before = events.length;
    const results = await Promise.allSettled([
      request(peer, `/session/${id}/commit`, { body: {} }),
      request(peer, `/session/${id}/commit`, { body: {} }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(events.length, before + 1);
  });
  await t.test('configuration check and staged inbox cleanup enforce safety boundaries', async () => {
    const validReceiver = path.join(root, 'receiver.local.json');
    await fs.writeFile(validReceiver, JSON.stringify({ bind: '127.0.0.1', port: 24814, token, inbox,
      certificate: path.join(root, 'cert.pem'), key: path.join(root, 'key.pem'), maxBytes: 67108864 }));
    const checked = await checkConfig(validReceiver);
    assert.equal(checked.kind, 'transport-receiver');
    const badConfig = path.join(root, 'bad.local.json');
    await fs.writeFile(badConfig, JSON.stringify({ bind: '127.0.0.1', port: 24814, token: 'REPLACE_WITH_A_PRIVATE_PAIRING_TOKEN',
      inbox, certificate: path.join(root, 'cert.pem'), key: path.join(root, 'key.pem') }));
    await assert.rejects(checkConfig(badConfig), /token/iu);

    // Refuses to delete paths outside inbox or non-incoming directories.
    assert.equal(await cleanupStagedBatch(inbox, [path.join(root, '资料', '空.txt')]), false);
    const stagedCopy = (await send(peer, manifest)).paths[0];
    assert.equal(await cleanupStagedBatch(inbox, [stagedCopy]), true);
    await assert.rejects(fs.stat(path.dirname(stagedCopy)), { code: 'ENOENT' });
    const pruned = await pruneStagedInbox(inbox, { maxAgeMs: 0, activeFolder: path.dirname(received) });
    assert.ok(pruned >= 1);
    assert.equal((await fs.stat(path.join(received, '随机.bin'))).isFile(), true);
  });
});
