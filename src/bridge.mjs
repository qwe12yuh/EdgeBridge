// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { collect } from './files.mjs';
import { createReceiver, send } from './transport.mjs';
import { NativeHandoffs } from './handoff.mjs';

const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
if (config.log) {
  const log = createWriteStream(config.log, { flags: 'a', mode: 0o600 });
  for (const level of ['log', 'error']) console[level] = (...args) => log.write(args.map(String).join(' ') + '\n');
}
const peer = JSON.parse(await fs.readFile(config.peer, 'utf8'));
let sending = false;
let edge, eventTimer, heartbeatTimer, receiver, stopping = false;
const transfers = new AbortController();
const writeCommand = async command => {
  const line = JSON.stringify(command) + '\n';
  if (config.nativeIPC) await fs.appendFile(config.nativeIPC + '/commands.jsonl', line, { mode: 0o600 });
  else await new Promise((resolve, reject) => {
    if (!edge?.stdin.writable) return reject(Error('Native helper is unavailable'));
    edge.stdin.write(line, error => error ? reject(error) : resolve());
  });
};
const handoffs = new NativeHandoffs(writeCommand);
const shutdown = (code = 0) => {
  if (stopping) return;
  stopping = true;
  transfers.abort();
  handoffs.stop();
  if (eventTimer) clearInterval(eventTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  // GUI-launched macOS helpers are not children: explicitly ask them to quit too.
  void writeCommand({ command: 'shutdown' }).catch(() => {}).finally(() => {
    edge?.kill();
    if (receiver) { receiver.closeAllConnections(); receiver.close(() => { process.exitCode = code; }); }
    else process.exitCode = code;
  });
};
async function eventLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== 'object') return;
  console.log(JSON.stringify({ ...event, observedAt: new Date().toISOString() }));
  handoffs.event(event);
  if (event.event !== 'outgoing' || sending || !Array.isArray(event.paths)) return;
  sending = true;
  try {
    console.log(JSON.stringify({ event: 'sending', files: event.paths.length }));
    const result = await send(peer, await collect(event.paths), { signal: transfers.signal });
    console.log(JSON.stringify({ event: result.handoff?.copied ? 'landed' : 'stored-without-drop', handoff: result.handoff }));
  } catch (error) { console.error(JSON.stringify({ event: 'transfer-error', error: error.message })); }
  finally { sending = false; }
}
try {
if (config.nativeIPC) {
  await fs.mkdir(config.nativeIPC, { recursive: true, mode: 0o700 });
  const file = config.nativeIPC + '/events.jsonl';
  let consumed = (await fs.readFile(file, 'utf8').catch(() => '')).length;
  eventTimer = setInterval(async () => {
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    if (text.length < consumed) consumed = 0;
    const end = text.lastIndexOf('\n') + 1;
    if (end <= consumed) return;
    const pending = text.slice(consumed, end); consumed = end;
    for (const line of pending.trim().split('\n')) void eventLine(line);
  }, 100);
  heartbeatTimer = setInterval(() => {
    void fs.writeFile(config.nativeIPC + '/heartbeat', String(Date.now()), { mode: 0o600 })
      .catch(error => { console.error(error.message); shutdown(1); });
  }, 500);
} else {
  edge = spawn(config.nativeHelper, ['--edge', config.edge], { stdio: ['pipe', 'pipe', 'inherit'] });
  edge.on('spawn', () => console.log(JSON.stringify({ event: 'native-helper-spawned', pid: edge.pid })));
  edge.on('error', error => { console.error(error.message); shutdown(1); });
  edge.stdin.on('error', error => { console.error(error.message); shutdown(1); });
  edge.on('exit', () => { if (!stopping) shutdown(1); });
  const lines = readline.createInterface({ input: edge.stdout });
  lines.on('line', eventLine);
}
receiver = await createReceiver({
  cert: await fs.readFile(config.certificate), key: await fs.readFile(config.key),
  token: config.token, inbox: config.inbox,
  onReceived: async paths => {
    // Allow Deskflow to move the pointer onto this desktop before arming a drag.
    if (config.deskflowLog) {
      const deadline = Date.now() + 15000;
      let active = false;
      while (Date.now() < deadline && !stopping) {
        const log = await fs.readFile(config.deskflowLog, 'utf8');
        if (log.lastIndexOf('entering computer') > log.lastIndexOf('leaving computer')) { active = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!active) throw Error('Destination desktop is not active; native drag was not started');
    } else await new Promise(resolve => setTimeout(resolve, 250));
    // The local helper reads only already verified, locally staged paths.
    if (stopping) throw Error('Bridge stopped');
    if (handoffs.pending) throw Error('Another native drag is active');
    const completion = handoffs.start(paths);
    console.log(JSON.stringify({ event: 'incoming-ready', id: handoffs.pending.id, paths }));
    return completion;
  },
});
receiver.on('notificationError', e => console.error(e.message));
receiver.on('error', error => { console.error(error.message); shutdown(1); });
if (stopping) receiver.close();
else receiver.listen(config.port, config.bind, () => console.log(JSON.stringify({ event: 'listening', port: config.port })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown());
} catch (error) { console.error(error.message); shutdown(1); }
