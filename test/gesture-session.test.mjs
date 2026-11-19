// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SourceGesture } from '../src/gesture-session.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const route = [], native = [], remote = [], results = [];
  const g = new SourceGesture({ route: c => route.push(c), native: c => native.push(c), remote: c => remote.push(c),
    fixture: '/lab/fixture.txt', fixtureHash: 'a'.repeat(64), target: 'win', timeout: 100, ...options });
  g.on('result', result => results.push(result));
  t.after(() => { g.cancel(); t.mock.timers.tick(100); });
  const id = randomUUID(), generation = 7;
  const source = event => g.source({ id, observedGeneration: generation, ...event });
  const routed = event => g.routed({ id, generation, ...event });
  const received = event => g.received({ id, generation, ...event });
  const prepare = async () => {
    source({ event: 'source-prepare', paths: ['/lab/fixture.txt'], observedUptimeMs: 12345 });
    await flush(); routed({ event: 'prepared', seq: 1 }); await flush();
    received({ event: 'prepared' }); await flush();
  };
  const enter = async () => {
    await prepare(); routed({ event: 'commit', seq: 2 }); await flush();
    source({ event: 'source-accepted', generation }); await flush();
    routed({ event: 'entered', seq: 3 }); await flush();
  };
  return { g, id, generation, route, native, remote, results, source, routed, received, prepare, enter };
}
test('staging can take three seconds without extending other phase deadlines', async t => {
  const c = setup(t);
  c.source({ event: 'source-prepare', paths: ['/lab/fixture.txt'], observedUptimeMs: 12345 });
  c.routed({ event: 'prepared', seq: 1 }); await flush();
  t.mock.timers.tick(3000); await flush();
  assert.equal(c.g.session.phase, 'preparing-target');
  c.received({ event: 'prepared' }); await flush();
  assert.equal(c.g.session.phase, 'ready');
  c.routed({ event: 'commit', seq: 2 });
  t.mock.timers.tick(100); await flush();
  assert.equal(c.g.session.phase, 'cancelling');
});
test('staging exceeding the configured budget cancels and ignores late preparation', async t => {
  const c = setup(t, { stagingTimeout: 300 });
  c.source({ event: 'source-prepare', paths: ['/lab/fixture.txt'], observedUptimeMs: 12345 });
  c.routed({ event: 'prepared', seq: 1 }); await flush();
  t.mock.timers.tick(301); await flush();
  assert.equal(c.g.session.phase, 'cancelling');
  c.received({ event: 'prepared' }); await flush();
  assert.equal(c.route.some(command => command.command === 'ready'), false);
});
test('one physical gesture prepares, accepts source, activates, releases and finishes in order', async t => {
  const c = setup(t); await c.enter();
  assert.deepEqual(c.route.map(x => x.command), ['prepare', 'ready', 'source-accepted']);
  assert.equal(c.route[0].observedUptimeMs, 12345);
  assert.deepEqual(c.native.map(x => x.command), ['commit']);
  assert.deepEqual(c.remote.map(x => x.command), ['prepare', 'activate']);
  c.received({ event: 'drag-loop-running' }); c.received({ event: 'target-entered', hwnd: '123' });
  c.routed({ event: 'ended', seq: 4, reason: 'released' }); await flush();
  assert.equal(c.remote.at(-1).command, 'release');
  c.received({ event: 'ended', copied: true, accepted: true }); await flush();
  assert.equal(c.route.at(-1).command, 'finish'); assert.equal(c.results[0].accepted, true);
  assert.equal(c.results[0].experiment, 'pre-positioned-fixture');
});
test('entering the edge never releases the mouse or activates a native drag', async t => {
  const c = setup(t); await c.prepare(); t.mock.timers.tick(1000); await flush();
  assert.equal(c.g.session.phase, 'ready'); assert.equal(c.native.length, 0);
  assert.deepEqual(c.remote.map(x => x.command), ['prepare']);
});
test('retreat before commit cancels and late commit cannot synthesize release', async t => {
  const c = setup(t); await c.prepare(); c.source({ event: 'source-left' });
  c.routed({ event: 'commit', seq: 2 }); await flush();
  assert.equal(c.native.some(x => x.command === 'commit'), false);
  c.received({ event: 'ended', copied: false, accepted: false }); await flush();
  assert.equal(c.route.at(-1).command, 'finish'); assert.equal(c.results[0].accepted, false);
});
test('physical release before native activation cannot become a delayed drop', async t => {
  const c = setup(t); await c.prepare(); c.routed({ event: 'commit', seq: 2 }); await flush();
  c.routed({ event: 'ended', seq: 3, reason: 'released' });
  c.source({ event: 'source-accepted', generation: c.generation }); c.routed({ event: 'entered', seq: 4 }); await flush();
  assert.equal(c.remote.some(x => x.command === 'activate'), false);
  c.received({ event: 'ended', copied: true, accepted: true }); assert.equal(c.results[0].accepted, false);
});
test('stale generations, route sequences and old results cannot advance the current gesture', async t => {
  const c = setup(t); await c.prepare();
  c.routed({ event: 'commit', seq: 1 }); c.routed({ event: 'commit', seq: 99, generation: 6 });
  c.g.received({ event: 'ended', id: randomUUID(), generation: 7, copied: true, accepted: true });
  await flush(); assert.equal(c.native.length, 0); assert.equal(c.g.session.phase, 'ready');
});
test('native result without observed loop and target does not report acceptance', async t => {
  const c = setup(t); await c.enter(); c.routed({ event: 'ended', seq: 4 });
  c.received({ event: 'ended', copied: true, accepted: true }); assert.equal(c.results[0].accepted, false);
});
test('a null target HWND cannot acknowledge entry into an actual drop target', async t => {
  const c = setup(t); await c.enter(); c.received({ event: 'drag-loop-running' });
  c.received({ event: 'target-entered', hwnd: '0' }); c.routed({ event: 'ended', seq: 4 });
  c.received({ event: 'ended', copied: true, accepted: true });
  assert.equal(c.results[0].accepted, false); assert.equal(c.results[0].nativeAccepted, true);
  assert.equal(c.results[0].targetObserved, false); assert.equal(c.results[0].destinationVerified, false);
});
test('late prepared after source retreat is cancelled with its actual generation', async t => {
  const c = setup(t); c.source({ event: 'source-prepare', paths: ['/lab/fixture.txt'], observedUptimeMs: 10 }); await flush();
  c.source({ event: 'source-left' }); await flush(); c.routed({ event: 'prepared', seq: 1 }); await flush();
  assert.equal(c.route.at(-1).command, 'cancel'); assert.equal(c.route.at(-1).generation, 7);
});
test('lab refuses arbitrary files and cancellation has a bounded recovery deadline', async t => {
  const c = setup(t); c.source({ event: 'source-prepare', paths: ['/private/other'], observedUptimeMs: 10 }); await flush();
  assert.equal(c.route.length, 0); await c.enter(); c.g.cancel('Link lost'); await flush();
  t.mock.timers.tick(100); await flush(); assert.equal(c.g.session, undefined);
  assert.equal(c.results[0].error, 'Link lost'); assert.equal(c.route.at(-1).command, 'finish');
});
test('drop-released finishes the router immediately and waits for slow post-release OLE copy', async t => {
  const c = setup(t); await c.enter();
  c.received({ event: 'drag-loop-running' }); c.received({ event: 'target-entered', hwnd: '456' });
  c.routed({ event: 'ended', seq: 4, reason: 'released' }); await flush();
  assert.equal(c.remote.at(-1).command, 'release');
  c.received({ event: 'drop-released' }); await flush();
  assert.equal(c.route.at(-1).command, 'finish');
  // Router finish-timeout or elapsed >100ms phase timeout does not abort an active post-release copy within finishTimeout (400ms).
  c.routed({ event: 'cancelled', seq: 5, reason: 'finish-timeout' });
  t.mock.timers.tick(250); await flush();
  assert.equal(c.results.length, 0);
  c.received({ event: 'ended', copied: true, accepted: true }); await flush();
  assert.equal(c.results.length, 1);
  assert.equal(c.results[0].accepted, true);
  assert.equal(c.route.filter(x => x.command === 'finish').length, 1);

  // Without drop-released, router finish-timeout must still cancel the session.
  const nextId = randomUUID(), nextGen = 8;
  c.g.source({ id: nextId, observedGeneration: nextGen, event: 'source-prepare', paths: ['/lab/fixture.txt'], observedUptimeMs: 12350 });
  await flush(); c.g.routed({ id: nextId, generation: nextGen, event: 'prepared', seq: 1 }); await flush();
  c.g.received({ id: nextId, generation: nextGen, event: 'prepared' }); await flush();
  c.g.routed({ id: nextId, generation: nextGen, event: 'commit', seq: 2 }); await flush();
  c.g.source({ id: nextId, generation: nextGen, event: 'source-accepted' }); await flush();
  c.g.routed({ id: nextId, generation: nextGen, event: 'entered', seq: 3 }); await flush();
  c.g.received({ id: nextId, generation: nextGen, event: 'drag-loop-running' });
  c.g.received({ id: nextId, generation: nextGen, event: 'target-entered', hwnd: '456' });
  c.g.routed({ id: nextId, generation: nextGen, event: 'ended', seq: 4, reason: 'released' }); await flush();
  c.g.routed({ id: nextId, generation: nextGen, event: 'cancelled', seq: 5, reason: 'finish-timeout' }); await flush();
  assert.equal(c.g.session.phase, 'cancelling');
  t.mock.timers.tick(100); await flush();

  // If drop-released arrives in active phase before router ended, router finish is sent immediately on ended.
  const earlyId = randomUUID(), earlyGen = 9;
  c.g.source({ id: earlyId, observedGeneration: earlyGen, event: 'source-prepare', paths: ['/lab/fixture.txt'], observedUptimeMs: 12360 });
  await flush(); c.g.routed({ id: earlyId, generation: earlyGen, event: 'prepared', seq: 1 }); await flush();
  c.g.received({ id: earlyId, generation: earlyGen, event: 'prepared' }); await flush();
  c.g.routed({ id: earlyId, generation: earlyGen, event: 'commit', seq: 2 }); await flush();
  c.g.source({ id: earlyId, generation: earlyGen, event: 'source-accepted' }); await flush();
  c.g.routed({ id: earlyId, generation: earlyGen, event: 'entered', seq: 3 }); await flush();
  c.g.received({ id: earlyId, generation: earlyGen, event: 'drag-loop-running' });
  c.g.received({ id: earlyId, generation: earlyGen, event: 'target-entered', hwnd: '456' });
  c.g.received({ id: earlyId, generation: earlyGen, event: 'drop-released' }); await flush();
  assert.equal(c.route.filter(x => x.id === earlyId && x.command === 'finish').length, 0);
  c.g.routed({ id: earlyId, generation: earlyGen, event: 'ended', seq: 4, reason: 'released' }); await flush();
  assert.equal(c.route.at(-1).command, 'finish');
  assert.equal(c.route.at(-1).id, earlyId);
  c.g.received({ id: earlyId, generation: earlyGen, event: 'ended', copied: true, accepted: true }); await flush();
  assert.equal(c.results.at(-1).accepted, true);
});
test('late native completion after finish timeout is surfaced once for matching generation only', async t => {
  const c = setup(t); const late = [];
  c.g.on('late-result', event => late.push(event));
  await c.enter();
  c.received({ event: 'drag-loop-running' }); c.received({ event: 'target-entered', hwnd: '789' });
  c.routed({ event: 'ended', seq: 4, reason: 'released' });
  c.received({ event: 'drop-released' }); await flush();
  t.mock.timers.tick(500); await flush();
  assert.equal(c.results[0].accepted, false);
  assert.equal(c.remote.some(x => x.command === 'cancel'), false);
  // Non-copied end or wrong generation must not trigger late-result.
  c.received({ event: 'ended', copied: false, accepted: false });
  c.g.received({ event: 'ended', id: c.id, generation: c.generation + 1, copied: true, accepted: true });
  assert.equal(late.length, 0);
  c.received({ event: 'ended', copied: true, accepted: true });
  c.received({ event: 'ended', copied: true, accepted: true });
  assert.deepEqual(late, [{ id: c.id, generation: c.generation, accepted: true, copied: true }]);
});
