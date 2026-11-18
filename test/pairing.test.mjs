import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { checkConfig, loadReceiverConfig } from '../src/config-check.mjs';
import { collect } from '../src/files.mjs';
import { createReceiver, request, send } from '../src/transport.mjs';

const exec = promisify(execFile);
const init = dir => exec(process.execPath, ['src/cli.mjs', 'init-pair', dir]);

test('one pairing creates relocatable and independently authenticated receivers in both directions', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edgebridge-pair-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const pair = path.join(root, 'pair');
  const { stdout } = await init(pair);
  assert.match(stdout, /does not enable native screen dragging/u);
  await assert.rejects(init(pair), /new empty directory/u);

  async function start(name) {
    const dir = path.join(root, `relocated-${name}`);
    await fs.rename(path.join(pair, name), dir);
    const receiverFile = path.join(dir, 'receiver.local.json');
    const peerFile = path.join(dir, 'peer.local.json');
    const receiver = await loadReceiverConfig(receiverFile);
    const peer = JSON.parse(await fs.readFile(peerFile, 'utf8'));
    assert.equal((await checkConfig(receiverFile)).kind, 'transport-receiver');
    assert.equal((await checkConfig(peerFile)).kind, 'transport-peer');
    assert.equal(receiver.bind, '127.0.0.1');
    assert.equal(receiver.inbox, path.join(dir, 'inbox'));
    const cert = await fs.readFile(receiver.certificate, 'utf8');
    const key = await fs.readFile(receiver.key);
    const server = await createReceiver({ cert, key, token: receiver.token, inbox: receiver.inbox });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, receiver.bind, resolve); });
    context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return { peer, server, cert, dir, token: receiver.token, port: receiver.port };
  }

  const first = await start('first'), second = await start('second');
  assert.notEqual(first.cert, second.cert);
  assert.notEqual(first.token, second.token);
  for (const [from, to, label] of [[first, second, '第一台'], [second, first, '第二台']]) {
    assert.equal(from.peer.certificate, to.cert);
    assert.equal(from.peer.baseURL, `https://127.0.0.1:${to.port}`);
    const peer = { ...from.peer, baseURL: `https://127.0.0.1:${to.server.address().port}` };
    await assert.rejects(request({ ...peer, token: from.token }, '/health'), /Unauthorized/u);
    const file = path.join(from.dir, `${label}.txt`);
    await fs.writeFile(file, label);
    const result = await send(peer, await collect([file]));
    assert.equal(await fs.readFile(result.paths[0], 'utf8'), label);
    assert.equal(await fs.readFile(file, 'utf8'), label);
    assert.ok(result.paths[0].startsWith(path.join(to.dir, 'inbox') + path.sep));
  }
});
