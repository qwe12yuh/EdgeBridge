// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SourceGesture } from '../src/gesture-session.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const route = [], native = [], remote = [], results = [];
  const gesture = new SourceGesture({ route: c => route.push(c), native: c => native.push(c), remote: c => remote.push(c),
    source: 'windows-peer', target: 'mac', edge: 'left', fixture: 'C:\\Users\\demo\\Desktop\\fixture.txt', fixtureHash: 'a'.repeat(64),
    normalize: value => path.win32.normalize(value).toLowerCase(), targetStartAck: true, requireTargetNotification: false, timeout: 100, ...options });
  gesture.on('result', result => results.push(result));
  t.after(() => { gesture.cancel(); t.mock.timers.tick(100); });
  const id = randomUUID(), generation = 9, token = 'one-time-source-acceptance-token';
  const source = event => gesture.source({ id, generation, ...event });
  const routed = event => gesture.routed({ id, generation, ...event });
  const received = event => gesture.received({ id, generation, ...event });
  const prepare = async () => {
    source({ event: 'source-prepare', paths: ['c:/users/demo/desktop/FIXTURE.txt'], observedGeneration: generation, observedUptimeMs: 10000 });
    await flush(); routed({ event: 'prepared', seq: 1 }); received({ event: 'prepared' }); await flush();
    routed({ event: 'commit', seq: 2, commitToken: token }); await flush();
  };
  const enter = async () => {
    await prepare(); source({ event: 'source-accepted', commitToken: token }); await flush();
    routed({ event: 'entered', seq: 3, physicalDownEventNumber: 41 }); await flush();
  };
  return { gesture, route, native, remote, results, source, routed, received, prepare, enter, token };
}
test('reverse routing binds Windows paths and one-time source acceptance token', async t => {
  const c = setup(t); await c.enter();
  assert.equal(c.route[0].source, 'windows-peer'); assert.equal(c.route[0].edge, 'left');
  assert.equal(c.native[0].commitToken, c.token); assert.equal(c.route[2].commitToken, c.token);
  assert.equal(c.remote.at(-1).physicalDownEventNumber, 41);
  c.received({ event: 'drag-loop-running' }); await flush();
  assert.equal(c.route.at(-1).command, 'target-started');
  c.routed({ event: 'ended', seq: 4 }); c.received({ event: 'ended', accepted: true, copied: true });
  assert.equal(c.results[0].accepted, true); assert.equal(c.results[0].destinationVerified, false);
});
test('reverse continuation requires the physical event number rather than a fabricated pairing', async t => {
  const c = setup(t); await c.prepare(); c.source({ event: 'source-accepted', commitToken: c.token }); await flush();
  c.routed({ event: 'entered', seq: 3, physicalDownEventNumber: 0x80000000 }); await flush();
  assert.equal(c.remote.some(command => command.command === 'activate'), false);
  assert.equal(c.gesture.session.phase, 'cancelling');
});
test('signed physical Quartz event numbers are preserved during reverse activation', async t => {
  const c = setup(t); await c.prepare(); c.source({ event: 'source-accepted', commitToken: c.token }); await flush();
  c.routed({ event: 'entered', seq: 3, physicalDownEventNumber: -1 }); await flush();
  assert.equal(c.remote.at(-1).command, 'activate');
  assert.equal(c.remote.at(-1).physicalDownEventNumber, -1);
});
test('reverse source cannot acknowledge a different commit token', async t => {
  const c = setup(t); await c.prepare(); c.source({ event: 'source-accepted', commitToken: 'stale-token' }); await flush();
  assert.equal(c.route.some(command => command.command === 'source-accepted'), false);
  assert.equal(c.gesture.session.phase, 'cancelling');
});
test('AppKit completion arriving before queued physical-up acknowledgment waits for authority', async t => {
  const c = setup(t); await c.enter(); c.received({ event: 'drag-loop-running' });
  c.received({ event: 'ended', accepted: true, copied: true }); await flush();
  assert.equal(c.results.length, 0); assert.equal(c.gesture.session.phase, 'active');
  c.routed({ event: 'ended', seq: 4 }); await flush();
  assert.equal(c.results[0].accepted, true); assert.equal(c.route.at(-1).command, 'finish');
});
test('late AppKit start after early physical release cannot re-arm local button delivery', async t => {
  const c = setup(t); await c.enter(); c.routed({ event: 'cancelled', seq: 4, reason: 'released-before-target-start' });
  c.received({ event: 'drag-loop-running' }); await flush();
  assert.equal(c.route.some(command => command.command === 'target-started'), false);
  c.received({ event: 'ended', accepted: false, copied: false });
  assert.equal(c.results[0].accepted, false);
});
test('real-file mode preserves the selected paths without substituting the fixture', async t => {
  const c = setup(t, { allowSelection: true });
  c.source({ event: 'source-prepare', paths: ['C:\\Users\\demo\\Desktop\\实际文件.txt'], observedGeneration: 9, observedUptimeMs: 10000 }); await flush();
  assert.deepEqual(c.gesture.session.paths, ['C:\\Users\\demo\\Desktop\\实际文件.txt']);
  assert.equal(c.route[0].command, 'prepare');
});
test('reverse success requires the core to verify native end against the real HID up', async t => {
  const c = setup(t, { verifyTargetEnd: true }); await c.enter(); c.received({ event: 'drag-loop-running' }); await flush();
  c.received({ event: 'drop-released' }); await flush();
  assert.equal(c.route.some(x => x.command === 'finish'), false);
  c.received({ event: 'ended', accepted: true, copied: true, nativeEndedUptimeMs: 10100 }); await flush();
  assert.equal(c.route.at(-1).command, 'target-ended'); assert.equal(c.results.length, 0);
  c.routed({ event: 'target-ended-verified', seq: 4 }); assert.equal(c.results.length, 0);
  c.routed({ event: 'ended', seq: 5 }); await flush();
  assert.equal(c.results[0].accepted, true);
  assert.equal(c.route.at(-1).command, 'finish');
});
test('a native drop that precedes physical release is cancelled, not matched to a later release', async t => {
  const c = setup(t, { verifyTargetEnd: true }); await c.enter(); c.received({ event: 'drag-loop-running' });
  c.received({ event: 'ended', accepted: true, copied: true, nativeEndedUptimeMs: 10100 }); await flush();
  c.routed({ event: 'cancelled', seq: 4, reason: 'native-ended-before-physical-up' }); await flush();
  assert.equal(c.results[0].accepted, false); assert.equal(c.gesture.session, undefined);
  c.routed({ event: 'ended', seq: 5 }); assert.equal(c.results.length, 1);
});
test('destination down permit is correlated with one actual helper window and physical generation', async t => {
  const c = setup(t, { destinationStart: true }); await c.enter();
  c.received({ event: 'destination-start-request', pid: 100, window: 200, physicalDownEventNumber: 41 }); await flush();
  assert.deepEqual(c.route.at(-1), { command: 'destination-start', id: c.gesture.session.id, generation: 9, pid: 100, window: 200, physicalDownEventNumber: 41 });
  c.routed({ event: 'destination-start-permitted', seq: 4, pid: 100, window: 200, physicalDownEventNumber: 41, nonce: '454244530123abcd', expiresUptimeMs: 10500 }); await flush();
  assert.equal(c.remote.at(-1).command, 'start-permitted');
  assert.equal(c.remote.at(-1).nonce, '454244530123abcd');
  c.received({ event: 'drag-loop-running' }); await flush();
  assert.equal(c.route.at(-1).command, 'target-started');
  t.mock.timers.tick(1000); assert.equal(c.gesture.session.phase, 'active');
});
test('stale destination permission cannot be posted after physical release', async t => {
  const c = setup(t, { destinationStart: true }); await c.enter();
  c.received({ event: 'destination-start-request', pid: 100, window: 200, physicalDownEventNumber: 41 }); await flush();
  c.routed({ event: 'ended', seq: 4 });
  c.routed({ event: 'destination-start-permitted', seq: 5, pid: 100, window: 200, physicalDownEventNumber: 41, nonce: '454244530123abcd', expiresUptimeMs: 10500 }); await flush();
  assert.equal(c.remote.some(command => command.command === 'start-permitted'), false);
});
test('wrong destination window cannot start or acknowledge an unpermitted native drag', async t => {
  const c = setup(t, { destinationStart: true }); await c.enter();
  c.received({ event: 'destination-start-request', pid: 100, window: 200, physicalDownEventNumber: 41 }); await flush();
  c.routed({ event: 'destination-start-permitted', seq: 4, pid: 100, window: 201, physicalDownEventNumber: 41, nonce: '454244530123abcd', expiresUptimeMs: 10500 }); await flush();
  assert.equal(c.remote.some(command => command.command === 'start-permitted'), false);
  assert.equal(c.gesture.session.phase, 'cancelling');
  c.received({ event: 'drag-loop-running' }); await flush();
  assert.equal(c.route.some(command => command.command === 'target-started'), false);
});
