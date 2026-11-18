import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { PrimaryOle } from '../src/primary-ole.mjs';
import { peerAppKit } from '../src/peer-appkit.mjs';
import { SourceGesture } from '../src/gesture-session.mjs';
import { checkConfig } from '../src/config-check.mjs';

const exec = promisify(execFile);
const fixture = id => ({ id, generation: 2 });

test('Windows primary forwards one scoped local release and never sends a stale OLE command', async context => {
  const sent = [], routed = [], remote = [];
  const ole = new PrimaryOle(command => { sent.push(command); });
  const gesture = new SourceGesture({ source: 'first', target: 'second',
    native: command => ole.sourceCommand(command), route: command => { routed.push(command); },
    remote: command => { remote.push(command); }, allowSelection: true, requireSourceWindow: true });
  context.after(() => clearTimeout(gesture.timer));
  const id = randomUUID(), ignored = randomUUID();
  gesture.source({ event: 'source-prepare', id: ignored, observedGeneration: 1, observedUptimeMs: 5000,
    paths: ['C:\\test\\sample.txt'], sourceWindow: '0' });
  await setImmediate();
  assert.equal(routed.length, 0);
  const prepare = { event: 'source-prepare', id, observedGeneration: 2, observedUptimeMs: 5500,
    paths: ['C:\\test\\sample.txt'], sourceWindow: '73' };
  ole.observe(prepare); gesture.source(prepare);
  await setImmediate();
  assert.equal(routed.at(-1).sourceWindow, '73');
  gesture.routed({ event: 'prepared', ...fixture(id), seq: 1 });
  gesture.received({ event: 'prepared', ...fixture(id) });
  const token = randomUUID();
  gesture.routed({ event: 'commit', ...fixture(id), seq: 2, commitToken: token });
  await setImmediate();
  assert.deepEqual(sent.at(-1), { command: 'source-commit', ...fixture(id), commitToken: token, sourceSeq: 1 });
  gesture.source({ event: 'source-accepted', ...fixture(id), commitToken: token });
  gesture.routed({ event: 'entered', ...fixture(id), seq: 3 });
  gesture.routed({ event: 'ended', ...fixture(id), seq: 4 });
  gesture.received({ event: 'ended', ...fixture(id), copied: false });
  await setImmediate();
  assert.deepEqual(remote.map(command => command.command), ['prepare', 'activate', 'release']);
  assert.equal(sent.at(-1).command, 'source-reset');
  const count = sent.length;
  await ole.sourceCommand({ command: 'commit', ...fixture(id), commitToken: token });
  assert.equal(sent.length, count);
});

test('local OLE target binds release and heartbeat to the prepared generation', () => {
  const sent = [], ole = new PrimaryOle(command => sent.push(command));
  const id = randomUUID();
  ole.targetCommand({ command: 'prepare', ...fixture(id), paths: ['C:\\received\\sample.txt'] });
  ole.targetCommand({ command: 'release', id, generation: 1 });
  ole.heartbeat();
  ole.targetCommand({ command: 'activate', ...fixture(id) });
  ole.targetCommand({ command: 'release', ...fixture(id) });
  ole.observe({ event: 'ended', ...fixture(id) });
  ole.heartbeat();
  assert.deepEqual(sent.map(command => [command.command, command.seq]),
    [['prepare', 1], ['heartbeat', 2], ['activate', 3], ['release', 4]]);
});

test('Mac source bridge keeps the router clock sample and rejects target commands', { skip: process.platform === 'win32' }, async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edgebridge-native-peer-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ipc = await peerAppKit(directory, () => {}, () => {});
  context.after(() => ipc.close());
  const id = randomUUID(), commitToken = randomUUID();
  await ipc.send({ command: 'candidate', generation: 2, time: 17, observedUptimeMs: 7654 });
  await ipc.send({ command: 'source-commit', ...fixture(id), commitToken });
  await assert.rejects(ipc.send({ command: 'activate', ...fixture(id) }), /only supports the source experiment/u);
  const [candidate, commit] = (await fs.readFile(path.join(directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(candidate.observedUptimeMs, 7654);
  assert.ok(Math.abs(candidate.time - Date.now()) < 2000);
  assert.deepEqual(commit, { command: 'commit', ...fixture(id), commitToken });
  ipc.close();
});

test('both experimental setup modes generate private pairings that pass preflight', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edgebridge-native-pair-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const mode of ['init-windows-lab', 'init-mac-peer-lab']) {
    const pair = path.join(directory, mode);
    await exec(process.execPath, ['src/cli.mjs', mode, pair, 'first', 'second']);
    assert.equal((await checkConfig(path.join(pair, 'primary', 'primary.local.json'))).kind, 'gesture-source');
    assert.equal((await checkConfig(path.join(pair, 'secondary', 'secondary.local.json'))).kind, 'gesture-destination');
  }
});
