// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeHandoffs } from '../src/handoff.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = [];
  const h = new NativeHandoffs(command => commands.push(command), { startTimeout: 100, dropTimeout: 1000 });
  t.after(() => h.stop());
  return { h, commands };
}

test('native completion requires a matching start and end, never a stale event', async t => {
  const { h, commands } = setup(t);
  const result = h.start(['/verified/file']); await flush();
  const { id } = commands[0];
  assert.equal(h.event({ event: 'native-drag-ended', id: 'previous-drag', copied: true }), false);
  assert.equal(h.event({ event: 'native-drag-started', id }), true);
  h.event({ event: 'native-drag-ended', id, copied: true });
  assert.deepEqual(await result, { id, copied: true });
});

test('missing native start cancels the helper and permits a retry', async t => {
  const { h, commands } = setup(t);
  const result = h.start(['/verified/file']); await flush();
  await assert.rejects(h.start(['/other']), /active/u);
  t.mock.timers.tick(100); await flush();
  assert.match((await result).error, /did not start/u);
  assert.deepEqual(commands[1], { command: 'cancel', id: commands[0].id });
  const next = h.start(['/retry']); await flush();
  h.event({ event: 'native-drag-ended', id: commands[0].id, copied: true });
  assert.equal(h.pending.id, commands[2].id);
  h.stop(); assert.equal((await next).copied, false);
});

test('started drag has a separate completion deadline and cannot extend it with duplicate starts', async t => {
  const { h, commands } = setup(t);
  const result = h.start(['/verified/file']); await flush();
  const { id } = commands[0];
  h.event({ event: 'native-drag-started', id });
  t.mock.timers.tick(900);
  h.event({ event: 'native-drag-started', id });
  t.mock.timers.tick(100); await flush();
  assert.match((await result).error, /acknowledge completion/u);
  assert.equal(commands[1].command, 'cancel');
});

test('early release is returned immediately and an end without a start cannot report success', async t => {
  const { h, commands } = setup(t);
  let result = h.start(['/verified/file']); await flush();
  h.event({ event: 'native-drag-ended', id: commands[0].id, copied: false, error: 'Mouse button released' });
  assert.equal((await result).error, 'Mouse button released');
  result = h.start(['/retry']); await flush();
  h.event({ event: 'native-drag-ended', id: commands[1].id, copied: true });
  assert.equal((await result).copied, false);
});

test('failed helper writes and bridge shutdown resolve pending handoffs without hanging', async t => {
  const { h, commands } = setup(t);
  const result = h.start(['/verified/file']);
  h.stop('Helper exited'); await flush();
  assert.equal((await result).error, 'Helper exited');
  assert.equal(commands.some(command => command.command === 'incoming'), false);
  const broken = new NativeHandoffs(() => { throw Error('Pipe closed'); });
  assert.equal((await broken.start(['/verified/file'])).error, 'Pipe closed');
});
