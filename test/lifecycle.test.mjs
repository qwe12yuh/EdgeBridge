// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// A pipe-only fake helper: these tests never start desktop UI or inject input.
test('bridge lifecycle cleans up its helper on port collision, helper failure and shutdown',
  { skip: process.platform === 'win32' ? 'POSIX pipe-only helper fixture; Windows native checks run separately' : false }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edgebridge-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=lifecycle-test',
    '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')], { stdio: 'ignore' });
  const helper = path.join(root, 'helper.mjs');
  await fs.writeFile(helper, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n`, { mode: 0o700 });
  const peer = path.join(root, 'peer.json'); await fs.writeFile(peer, '{}');
  const config = { certificate: path.join(root, 'cert.pem'), key: path.join(root, 'key.pem'),
    token: 'test-only-token-'.repeat(4), peer, nativeHelper: helper, edge: 'right',
    inbox: path.join(root, 'inbox'), bind: '127.0.0.1', port: 0 };
  async function launch(overrides = {}) {
    const file = path.join(root, 'receiver.json');
    await fs.writeFile(file, JSON.stringify({ ...config, ...overrides }));
    const child = spawn(process.execPath, ['src/bridge.mjs', file], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const exit = once(child, 'exit');
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return { child, exit, output: () => ({ stdout, stderr }) };
  }
  await t.test('occupied port exits nonzero and leaves no helper process', async () => {
    const occupied = net.createServer(); await new Promise(r => occupied.listen(0, '127.0.0.1', r));
    try {
      const run = await launch({ port: occupied.address().port });
      assert.equal((await run.exit)[0], 1);
      assert.match(run.output().stderr, /EADDRINUSE/u);
      const event = run.output().stdout.split('\n').filter(Boolean).map(JSON.parse).find(e => e.event === 'native-helper-spawned');
      assert.ok(event?.pid);
      assert.throws(() => process.kill(event.pid, 0), { code: 'ESRCH' });
    } finally { await new Promise(r => occupied.close(r)); }
  });
  await t.test('a missing helper exits nonzero rather than running a receiver alone', async () => {
    const run = await launch({ nativeHelper: path.join(root, 'missing-helper') });
    assert.equal((await run.exit)[0], 1);
    assert.match(run.output().stderr, /ENOENT/u);
  });
  await t.test('SIGTERM tells a GUI helper to quit and releases the receiver', async () => {
    const ipc = path.join(root, 'ipc');
    const run = await launch({ nativeIPC: ipc });
    for (let i = 0; i < 100 && !run.output().stdout.includes('listening'); i++) await delay(10);
    assert.match(run.output().stdout, /listening/u);
    run.child.kill('SIGTERM');
    assert.equal((await run.exit)[0], 0);
    const commands = (await fs.readFile(path.join(ipc, 'commands.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(commands.at(-1).command, 'shutdown');
  });
});
