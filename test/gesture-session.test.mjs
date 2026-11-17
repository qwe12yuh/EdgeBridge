// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SourceGesture } from '../src/gesture-session.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const route = [], native = [], remote = [], results = [];
  const g = new SourceGesture({ route: c => route.push(c), native: c => native.push(c), remote: c => remote.push(c),
    fixture: '/lab/fixture.txt', fixtureHash: 'a'.repeat(64), target: 'win', timeout: 100 });
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
