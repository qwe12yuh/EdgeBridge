// SPDX-License-Identifier: MIT
// Deliberately separate from the ordinary upload/commit prototype.
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import readline from 'node:readline';
import { SourceGesture } from './gesture-session.mjs';
import { JsonLines } from './json-lines.mjs';
import { connectControl, createControlServer } from './control-link.mjs';
import { cleanupStagedBatch, gestureInbox, selectedFiles, sameGesture } from './gesture-files.mjs';
import { checkConfig, loadReceiverConfig, readConfigJson, resolveFrom } from './config-check.mjs';

if (process.argv[2] === '--check') {
  try {
    const summary = await checkConfig(process.argv[3]);
    console.log(JSON.stringify({ event: 'config-valid', ...summary }));
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
const { baseDir, config: rawConfig } = await readConfigJson(process.argv[2]);
const resolveField = value => typeof value === 'string' && value ? resolveFrom(baseDir, value) : value;
const config = {
  ...rawConfig,
  certificate: resolveField(rawConfig.certificate),
  key: resolveField(rawConfig.key),
  nativeHelper: resolveField(rawConfig.nativeHelper),
  nativeIPC: resolveField(rawConfig.nativeIPC),
  routeSocket: resolveField(rawConfig.routeSocket),
  peerCertificate: resolveField(rawConfig.peerCertificate),
  uploadPeer: resolveField(rawConfig.uploadPeer),
  uploadReceiver: resolveField(rawConfig.uploadReceiver),
  fixture: resolveField(rawConfig.fixture),
  macIncomingFixture: resolveField(rawConfig.macIncomingFixture),
};
const log = value => console.log(JSON.stringify({ ...value, observedAt: new Date().toISOString(), monotonicNs: String(process.hrtime.bigint()) }));
const logCleanupError = error => log({ event: 'staging-cleanup-error', error: error.message });
const realFiles = config.realFiles === true;
const sha256 = realFiles ? undefined : createHash('sha256').update(await fs.readFile(config.fixture)).digest('hex');
if (!realFiles && sha256 !== config.fixtureHash) throw Error('Configured pre-positioned fixture hash does not match');
const timers = [], resources = [];
const uploadPeer = config.uploadPeer ? (await readConfigJson(config.uploadPeer, 'Upload peer configuration')).config : undefined;
const uploadConfig = config.uploadReceiver ? await loadReceiverConfig(config.uploadReceiver) : undefined;
if (realFiles && (!uploadPeer || !uploadConfig)) throw Error('Real-file mode requires a pinned upload peer and receiver configuration');
let stop = () => { for (const timer of timers) clearInterval(timer); for (const r of resources) { r.destroy?.(); r.kill?.(); r.close?.(); } };
if (config.role === 'destination') {
  let link, session, outgoing, sequence = 0, sourceSequence = 0, child, stopping = false;
  const cert = await fs.readFile(config.certificate), key = await fs.readFile(config.key);
  const sendNative = command => new Promise((resolve, reject) => {
    if (!child?.stdin.writable) return reject(Error('Native helper unavailable'));
    child.stdin.write(JSON.stringify(command) + '\n', error => error ? reject(error) : resolve());
  });
  const cancel = () => {
    if (session?.nativePrepared !== false) { if (session) void sendNative({ command: 'cancel', ...session, seq: ++sequence }).catch(() => {}); }
    else { void link?.send({ event: 'ended', id: session.id, generation: session.generation, copied: false, accepted: false, error: 'Upload cancelled before native preparation' }).catch(() => {}); session = undefined; }
    if (outgoing) { outgoing.transfer?.abort(); void sendNative({ command: 'source-reset', id: outgoing.id, generation: outgoing.generation, sourceSeq: ++sourceSequence }).catch(() => {}); }
  };
  child = spawn(config.nativeHelper, ['--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] }); resources.push(child);
  child.stdin.on('error', error => { log({ event: 'native-error', error: error.message }); stop(); });
  child.on('error', error => { log({ event: 'native-error', error: error.message }); stop(); });
  child.on('exit', () => { if (!stopping) stop(); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let event; try { event = JSON.parse(line); } catch { return; }
    log(event);
    if (typeof event.event === 'string' && event.event.startsWith('source-')) {
      if (event.event === 'source-prepare') { outgoing = { id: event.id, generation: event.observedGeneration, paths: [...event.paths] }; sourceSequence = 0; }
      void link?.send(event).catch(() => cancel());
      return;
    }
    if (!session || event.id !== session.id || event.generation !== session.generation) return;
    void link?.send(event).catch(() => cancel());
    if (event.event === 'ended') {
      if (event.copied === false && event.accepted === false && session.stagedPaths && uploadConfig?.inbox) {
        void cleanupStagedBatch(uploadConfig.inbox, session.stagedPaths, { onError: logCleanupError });
      }
      session = undefined;
    }
  });
  const uploads = realFiles ? await gestureInbox(uploadConfig, {
    activePaths: () => session?.stagedPaths ? [session.stagedPaths] : [],
    onCleanupError: logCleanupError,
    authorized: context => !stopping && sameGesture(context, session) && session.nativePrepared === false,
    verified: async (paths, context) => {
      if (!sameGesture(context, session)) throw Error('Incoming gesture ended');
      session.nativePrepared = true;
      session.stagedPaths = paths;
      await sendNative({ command: 'prepare', id: session.id, generation: session.generation, seq: ++sequence, paths, leaseMs: 2000 });
      log({ event: 'bytes-staged', id: session.id, files: paths.length });
    },
  }) : undefined;
  if (uploads) {
    resources.push(uploads); uploads.on('error', error => { log({ event: 'upload-error', error: error.message }); stop(); });
    uploads.on('notificationError', error => log({ event: 'upload-error', error: error.message }));
    await new Promise(resolve => uploads.listen(uploadConfig.port, uploadConfig.bind || '127.0.0.1', resolve));
  }
  const server = createControlServer({ cert, key, token: config.token,
    onConnection: candidate => {
      if (link && !link.stream.destroyed) { candidate.stream.destroy(); return; }
      link = candidate;
      candidate.on('message', message => {
        if (message.command === 'heartbeat') return;
        if (['candidate', 'candidate-ended'].includes(message.command)) {
          void sendNative({ ...message, routeSeq: message.seq }).catch(() => cancel()); return;
        }
        if (['source-commit', 'source-reset'].includes(message.command)) {
          if (outgoing && outgoing.id === message.id && (!message.generation || outgoing.generation === message.generation)) {
            void sendNative({ command: message.command, ...outgoing, sourceSeq: ++sourceSequence, commitToken: message.commitToken }).catch(() => cancel());
            if (message.command === 'source-reset') { outgoing.transfer?.abort(); outgoing = undefined; }
          }
          return;
        }
        if (message.command === 'transfer-source') {
          const current = outgoing;
          if (!realFiles || !current || message.id !== current.id || message.generation !== current.generation || current.transfer) return;
          current.transfer = new AbortController();
          void selectedFiles(uploadPeer, current.paths, { gestureId: current.id, generation: current.generation }, { signal: current.transfer.signal })
            .then(meta => { log({ event: 'bytes-verified', direction: 'windows-to-mac', id: current.id, bytes: meta.bytes }); })
            .catch(error => { void candidate.send({ event: 'transfer-error', id: current.id, generation: current.generation, error: error.message }).catch(() => {}); });
          return;
        }
        if (message.command === 'upload-prepare') {
          if (!realFiles || session || outgoing) { void candidate.send({ event: 'transfer-error', id: message.id, generation: message.generation, error: 'Destination busy' }).catch(() => {}); return; }
          session = { id: message.id, generation: message.generation, nativePrepared: false }; sequence = 0;
          void candidate.send({ event: 'upload-ready', id: session.id, generation: session.generation }).catch(() => cancel()); return;
        }
        if (message.command === 'prepare') {
          if (realFiles) return;
          if (typeof message.id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(message.id) || !Number.isInteger(message.generation) || message.generation < 1 || message.generation > 0xffffffff) { candidate.stream.destroy(Error('Invalid gesture envelope')); return; }
          if (session || message.fixtureHash !== sha256) {
            void candidate.send({ event: 'ended', id: message.id, generation: message.generation, copied: false, accepted: false, error: 'Fixture mismatch or destination busy' }).catch(() => {}); return;
          }
          session = { id: message.id, generation: message.generation }; sequence = 0;
          void sendNative({ command: 'prepare', ...session, seq: ++sequence, paths: [config.fixture], leaseMs: 2000 }).catch(error => { log({ event: 'native-error', error: error.message }); cancel(); });
        } else if (session && message.id === session.id && message.generation === session.generation && ['activate', 'release', 'cancel'].includes(message.command)) {
          if (!session.nativePrepared && realFiles) { if (message.command === 'cancel') cancel(); return; }
          void sendNative({ command: message.command, id: session.id, generation: session.generation, seq: ++sequence }).catch(() => cancel());
        }
      });
      candidate.on('closed', () => { if (link === candidate) { cancel(); link = undefined; } });
      candidate.on('failure', error => log({ event: 'control-error', error: error.message }));
    } });
  resources.push(server);
  timers.push(setInterval(() => {
    void link?.send({ event: 'heartbeat' }).catch(() => cancel());
    if (session && session.nativePrepared !== false && link && !link.stream.destroyed) void sendNative({ command: 'heartbeat', ...session, seq: ++sequence }).catch(() => cancel());
  }, 500));
  stop = () => {
    if (stopping) return; stopping = true; cancel();
    for (const timer of timers) clearInterval(timer);
    void sendNative({ command: 'shutdown' }).catch(() => {}).finally(() => { child.kill(); link?.stream.destroy(); server.close(); uploads?.closeAllConnections(); uploads?.close(); });
  };
  server.on('error', error => { log({ event: 'control-error', error: error.message }); stop(); });
  server.listen(config.port, config.bind || '127.0.0.1', () => log({ event: 'destination-ready', port: server.address().port, mode: realFiles ? 'verified-file-transfer' : 'pre-positioned-fixture' }));
} else if (config.role === 'source') {
  const macEdge = process.env.EDGEBRIDGE_MAC_EDGE ?? config.macEdge ?? 'right';
  if (macEdge !== 'left' && macEdge !== 'right') throw Error('Mac edge must be left or right');
  const windowsEdge = macEdge === 'right' ? 'left' : 'right';
  let stopping = false, nativePid, heartbeatWriting = false, tickCount = 0;
  await fs.mkdir(config.nativeIPC, { recursive: true, mode: 0o700 });
  let nativeWrites = Promise.resolve();
  const writeNative = command => (nativeWrites = nativeWrites.catch(() => {}).then(() => fs.appendFile(config.nativeIPC + '/commands.jsonl', JSON.stringify(command) + '\n', { mode: 0o600 })));
  const routerSocket = net.createConnection(config.routeSocket); resources.push(routerSocket);
  await once(routerSocket, 'connect');
  const route = new JsonLines(routerSocket);
  const link = await connectControl({ host: config.peerHost || '127.0.0.1', port: config.peerPort, certificate: await fs.readFile(config.peerCertificate), token: config.peerToken });
  resources.push(link.stream);
  const transfers = new Map(), uploadReady = new Map();
  let forward, reverse;
  const transferForward = async command => {
    if (!realFiles || command.command !== 'prepare') return link.send(command);
    const current = forward.session;
    if (!current || current.id !== command.id) throw Error('Outgoing gesture ended');
    const abort = new AbortController(); transfers.set(current.id, abort);
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { uploadReady.delete(current.id); reject(Error('Upload destination did not reserve the gesture')); }, 1500);
      uploadReady.set(current.id, { resolve: () => { clearTimeout(timer); uploadReady.delete(current.id); resolve(); }, reject: error => { clearTimeout(timer); uploadReady.delete(current.id); reject(error); } });
    });
    await Promise.all([link.send({ command: 'upload-prepare', id: current.id, generation: current.generation }), ready]);
    const meta = await selectedFiles(uploadPeer, current.paths, { gestureId: current.id, generation: current.generation }, { signal: abort.signal });
    log({ event: 'bytes-verified', direction: 'mac-to-windows', id: current.id, bytes: meta.bytes });
  };
  forward = new SourceGesture({ route: command => route.send(command), remote: transferForward, native: writeNative,
    allowSelection: realFiles, validPath: path.isAbsolute, fixture: config.fixture, fixtureHash: sha256, source: config.macName, target: config.target, edge: macEdge });
  reverse = config.windowsFixture || realFiles ? new SourceGesture({ route: command => route.send(command),
    native: command => link.send({ ...command, command: command.command === 'commit' ? 'source-commit' : 'source-reset' }),
    remote: command => realFiles && command.command === 'prepare' ? link.send({ command: 'transfer-source', id: command.id, generation: command.generation }) : writeNative({ ...command, command: 'incoming-' + command.command, ...(command.command === 'prepare' ? { paths: [config.macIncomingFixture || config.fixture] } : {}) }),
    fixture: config.windowsFixture, fixtureHash: sha256, source: config.target, target: config.macName, edge: windowsEdge,
    normalize: name => path.win32.normalize(name).toLowerCase(), allowSelection: realFiles, validPath: path.win32.isAbsolute,
    requireTargetNotification: false, targetStartAck: true, verifyTargetEnd: true, destinationStart: true }) : undefined;
  const gestures = [forward, ...(reverse ? [reverse] : [])];
  const stagedReverse = new Map();
  const uploads = realFiles ? await gestureInbox(uploadConfig, {
    activePaths: () => [...stagedReverse.values()],
    onCleanupError: logCleanupError,
    authorized: context => !stopping && sameGesture(context, reverse?.session) && reverse.session.phase === 'preparing-target' && !reverse.session.filesReady,
    verified: async (paths, context) => {
      if (!sameGesture(context, reverse?.session) || reverse.session.phase !== 'preparing-target') throw Error('Reverse gesture ended');
      reverse.session.filesReady = true;
      stagedReverse.set(context.gestureId, paths);
      if (stagedReverse.size > 32) stagedReverse.delete(stagedReverse.keys().next().value);
      await writeNative({ command: 'incoming-prepare', id: context.gestureId, generation: context.generation, paths });
      log({ event: 'bytes-staged', direction: 'windows-to-mac', id: context.gestureId, files: paths.length });
    },
  }) : undefined;
  if (uploads) {
    resources.push(uploads); uploads.on('error', error => { log({ event: 'upload-error', error: error.message }); stop(); });
    uploads.on('notificationError', error => log({ event: 'upload-error', error: error.message }));
    await new Promise(resolve => uploads.listen(uploadConfig.port, uploadConfig.bind || '127.0.0.1', resolve));
  }
  for (const gesture of gestures) {
    const direction = gesture === reverse ? 'windows-to-mac' : 'mac-to-windows';
    const cancelTransfer = value => { transfers.get(value.id)?.abort(); transfers.delete(value.id); uploadReady.get(value.id)?.reject(Error('Gesture cancelled')); };
    gesture.on('cancelling', cancelTransfer); gesture.on('result', cancelTransfer);
    gesture.on('drop-released', value => log({ event: 'gesture-drop-released', direction, ...value }));
    gesture.on('late-result', value => log({ event: 'gesture-late-result', direction, ...value }));
    gesture.on('result', value => log({ event: 'gesture-result', direction, ...value }));
    gesture.on('rejected', value => log({ event: 'source-rejected', ...value }));
  }
  const sourceEvent = (gesture, other, event) => {
    if (!gesture) return;
    if (event.event === 'source-prepare' && other?.session) { gesture.invoke(gesture.native, { command: 'reset', id: event.id }); return; }
    gesture.source(event);
  };
  route.on('message', event => {
    log({ component: 'router', ...event });
    if (event.event === 'candidate' || event.event === 'candidate-ended') {
      if (!nativePid) return; // do not capture a source drag before the Mac endpoint exists
      const command = { ...event, command: event.event, time: Date.now() }; delete command.event;
      if (event.source === config.target && event.target === config.macName && event.edge === windowsEdge) {
        void link.send(command).catch(stop);
      } else if (event.source === config.macName && event.target === config.target && event.edge === macEdge) {
        void writeNative(command).catch(stop);
      }
    } else {
      for (const gesture of gestures) gesture.routed(event);
    }
  });
  link.on('message', event => {
    if (event.event !== 'heartbeat') log({ component: 'windows-native', ...event });
    if (event.event === 'upload-ready') { if (sameGesture({ gestureId: event.id, generation: event.generation }, forward.session)) uploadReady.get(event.id)?.resolve(); return; }
    if (event.event === 'transfer-error') { for (const gesture of gestures) { if (gesture.session?.id === event.id) gesture.cancel(event.error); } return; }
    if (typeof event.event === 'string' && event.event.startsWith('source-')) sourceEvent(reverse, forward, event);
    else forward.received(event);
  });
  stop = () => {
    if (stopping) return; stopping = true; for (const gesture of gestures) gesture.cancel();
    for (const timer of timers) clearInterval(timer);
    void writeNative({ command: 'shutdown' }).catch(() => {}).finally(() => { routerSocket.destroy(); link.stream.destroy(); uploads?.closeAllConnections(); uploads?.close(); });
  };
  for (const connection of [route, link]) {
    connection.on('failure', error => { log({ event: 'control-error', error: error.message }); stop(); });
    connection.on('closed', stop);
  }
  let offset = (await fs.stat(config.nativeIPC + '/events.jsonl').catch(() => ({ size: 0 }))).size;
  let pending = Buffer.alloc(0), reading = false;
  timers.push(setInterval(async () => {
    if (reading || stopping) return; reading = true;
    let file;
    try {
      file = await fs.open(config.nativeIPC + '/events.jsonl', 'r');
      if ((await file.stat()).size < offset) { offset = 0; pending = Buffer.alloc(0); }
      const bytes = Buffer.alloc(65536), { bytesRead } = await file.read(bytes, 0, bytes.length, offset); offset += bytesRead;
      pending = Buffer.concat([pending, bytes.subarray(0, bytesRead)]);
      if (pending.length > 131072) throw Error('Native event frame too large');
      while (pending.includes(10)) {
        const end = pending.indexOf(10), line = pending.subarray(0, end); pending = pending.subarray(end + 1);
        const event = JSON.parse(line.toString('utf8')); log({ component: 'source-native', ...event });
        if (event.event === 'source-ready') {
          nativePid = event.pid;
          if (event.accessibility !== true) { log({ event: 'native-error', error: 'Source helper is not Accessibility-authorized' }); stop(); }
        }
        if (event.event === 'source-stopped') stop();
        if (typeof event.event === 'string' && event.event.startsWith('source-')) sourceEvent(forward, reverse, event);
        else {
          if (event.event === 'ended' && typeof event.id === 'string') {
            const stagedPaths = stagedReverse.get(event.id);
            stagedReverse.delete(event.id);
            if (stagedPaths && event.copied === false && event.accepted === false && uploadConfig?.inbox) {
              void cleanupStagedBatch(uploadConfig.inbox, stagedPaths, { onError: logCleanupError });
            }
          }
          reverse?.received(event);
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') { log({ event: 'native-error', error: error.message }); stop(); } }
    finally { await file?.close(); reading = false; }
  }, 20));
  timers.push(setInterval(() => {
    if (nativePid) {
      try { process.kill(nativePid, 0); }
      catch { log({ event: 'native-error', error: 'Source helper exited' }); stop(); return; }
    }
    void route.send({ command: 'heartbeat' }).catch(stop);
    if (++tickCount % 4 === 0 && !gestures.some(gesture => gesture.session)) void route.send({ command: 'status' }).catch(stop);
    void link.send({ command: 'heartbeat' }).catch(stop);
    if (!heartbeatWriting) {
      heartbeatWriting = true;
      const temporary = config.nativeIPC + '/.heartbeat-' + process.pid;
      void fs.writeFile(temporary, String(Date.now()), { mode: 0o600 }).then(() => fs.rename(temporary, config.nativeIPC + '/heartbeat'))
        .catch(stop).finally(() => { heartbeatWriting = false; });
    }
  }, 500));
  log({ event: 'source-coordinator-ready', macEdge, mode: realFiles ? 'verified-file-transfer' : 'pre-positioned-fixture' });
} else throw Error('Expected source or destination role');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop?.());
