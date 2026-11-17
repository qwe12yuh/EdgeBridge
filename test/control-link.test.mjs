// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { JsonLines } from '../src/json-lines.mjs';
import { createControlServer, connectControl } from '../src/control-link.mjs';

test('control framing handles fragmented UTF-8 and rejects oversized/non-object frames', async () => {
  const stream = new PassThrough(), lines = new JsonLines(stream), messages = [];
  lines.on('message', value => messages.push(value));
  const bytes = Buffer.from('{"name":"跨屏"}\n{"seq":2}\n');
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  assert.deepEqual(messages, [{ name: '跨屏' }, { seq: 2 }]); stream.destroy();
  for (const input of ['null\n', '[]\n', 'x'.repeat(65537)]) {
    const invalid = new PassThrough(), parser = new JsonLines(invalid);
    const failed = once(parser, 'failure'); invalid.write(input);
    assert.ok((await failed)[0] instanceof Error);
  }
});
test('control connection pins TLS, authenticates once and transports both directions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edgebridge-control-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=control-test',
    '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')], { stdio: 'ignore' });
  const cert = await fs.readFile(path.join(root, 'cert.pem')), key = await fs.readFile(path.join(root, 'key.pem'));
  const token = 'test-control-token-'.repeat(4), connections = [];
  const server = createControlServer({ cert, key, token, onConnection: link => {
    connections.push(link); link.on('message', message => void link.send({ event: 'ack', seq: message.seq }));
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const c of connections) c.stream.destroy(); await new Promise(resolve => server.close(resolve)); });
  const peer = { host: '127.0.0.1', port: server.address().port, certificate: cert, token };
  const bad = await connectControl({ ...peer, token: 'wrong' });
  await once(bad, 'closed'); assert.equal(connections.length, 0);
  const client = await connectControl(peer); t.after(() => client.stream.destroy());
  const reply = new Promise(resolve => client.on('message', message => { if (message.event === 'ack') resolve(message); }));
  await client.send({ command: 'prepare', seq: 9 });
  assert.deepEqual(await reply, { event: 'ack', seq: 9 }); assert.equal(connections.length, 1);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=untrusted',
    '-keyout', path.join(root, 'other-key.pem'), '-out', path.join(root, 'other-cert.pem')], { stdio: 'ignore' });
  await assert.rejects(connectControl({ ...peer, certificate: await fs.readFile(path.join(root, 'other-cert.pem')) }));
});
