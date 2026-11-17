// SPDX-License-Identifier: MIT
import { EventEmitter } from 'node:events';
import path from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export class SourceGesture extends EventEmitter {
  constructor({ route, native, remote, fixture, fixtureHash, target, source, edge = 'right',
    normalize = path.resolve, requireTargetNotification = true, targetStartAck = false, allowSelection = false,
    verifyTargetEnd = false, destinationStart = false, validPath = name => path.isAbsolute(name) || path.win32.isAbsolute(name), timeout = 2500 }) {
    super(); Object.assign(this, { route, native, remote, fixture: fixture ? normalize(fixture) : undefined, fixtureHash, target, sourceName: source, edge,
      normalize, requireTargetNotification, targetStartAck, allowSelection, verifyTargetEnd, destinationStart, validPath, timeout });
    this.retired = new Set();
  }
  invoke(fn, command) {
    Promise.resolve().then(() => fn(command)).catch(error => { if (this.session?.id === command.id) this.cancel(error.message); });
  }
  arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.cancel('Gesture phase timed out'), this.timeout);
  }
  source(event) {
    if (event.event === 'source-prepare') {
      if (this.session) { this.invoke(this.native, { command: 'reset', id: event.id }); return; }
      const pathsOK = Array.isArray(event.paths) && event.paths.length > 0 && event.paths.length <= 1000 && event.paths.every(name => typeof name === 'string' && !name.includes('\0') && this.validPath(name));
      const selectionOK = pathsOK && (this.allowSelection || (event.paths.length === 1 && this.normalize(event.paths[0]) === this.fixture));
      if (!uuid.test(event.id) || !selectionOK || !Number.isFinite(event.observedUptimeMs) || !Number.isInteger(event.observedGeneration) || event.observedGeneration < 1) {
        this.invoke(this.native, { command: 'reset', id: event.id });
        this.emit('rejected', { reason: this.allowSelection ? 'Invalid file selection or physical gesture' : 'Lab accepts only the configured pre-positioned fixture' }); return;
      }
      this.session = { id: event.id, phase: 'preparing', lastRouteSeq: 0, observedGeneration: event.observedGeneration, paths: [...event.paths] };
      this.arm();
      this.invoke(this.route, { command: 'prepare', id: event.id, target: this.target, ...(this.sourceName ? { source: this.sourceName } : {}), edge: this.edge,
        observedUptimeMs: event.observedUptimeMs, observedGeneration: event.observedGeneration });
      return;
    }
    const s = this.session;
    if (!s || event.id !== s.id) return;
    if (event.event === 'source-left' || event.event === 'source-refused') { this.cancel(event.reason || 'Source drag left the edge'); return; }
    if (event.event === 'source-accepted' && s.phase === 'committing' && event.generation === s.generation) {
      if (s.commitToken && event.commitToken !== s.commitToken) { this.cancel('Source acceptance token does not match this handoff'); return; }
      s.phase = 'source-accepted'; this.arm();
      this.invoke(this.route, { command: 'source-accepted', id: s.id, generation: s.generation, ...(s.commitToken ? { commitToken: s.commitToken } : {}) });
    }
  }
  routed(event) {
    const s = this.session;
    if (!s || event.id !== s.id) {
      if (this.retired.has(event.id) && event.event === 'prepared') {
        Promise.resolve(this.route({ command: 'cancel', id: event.id, generation: event.generation })).catch(() => {});
      }
      return;
    }
    if (event.event === 'rejected') { this.cancel(event.reason || 'Router rejected gesture'); return; }
    if (!Number.isSafeInteger(event.seq) || event.seq <= s.lastRouteSeq) return;
    if (event.event === 'prepared' && s.phase === 'preparing') {
      if (!Number.isInteger(event.generation) || event.generation < 1 || event.generation > 0xffffffff || event.generation !== s.observedGeneration) { this.cancel('Invalid physical gesture generation'); return; }
      s.generation = event.generation; s.lastRouteSeq = event.seq; s.phase = 'preparing-target'; this.arm();
      this.invoke(this.remote, { command: 'prepare', id: s.id, generation: s.generation, fixtureHash: this.fixtureHash });
      return;
    }
    if (event.generation !== s.generation) return;
    s.lastRouteSeq = event.seq;
    if (event.event === 'cancelled') { this.cancel(event.reason || 'Router cancelled gesture'); return; }
    if (event.event === 'commit' && s.phase === 'ready') {
      s.commitToken = event.commitToken;
      s.phase = 'committing'; this.arm();
      this.invoke(this.native, { command: 'commit', id: s.id, generation: s.generation, ...(s.commitToken ? { commitToken: s.commitToken } : {}) });
    } else if (event.event === 'entered' && s.phase === 'source-accepted') {
      if (this.targetStartAck && (!Number.isInteger(event.physicalDownEventNumber) || event.physicalDownEventNumber < -0x80000000 || event.physicalDownEventNumber > 0x7fffffff)) {
        this.cancel('Missing physical mouse event number for native continuation'); return;
      }
      s.phase = 'active'; clearTimeout(this.timer);
      s.physicalDownEventNumber = event.physicalDownEventNumber;
      this.invoke(this.remote, { command: 'activate', id: s.id, generation: s.generation,
        ...(this.targetStartAck ? { physicalDownEventNumber: event.physicalDownEventNumber } : {}) });
    } else if (event.event === 'destination-start-permitted' && this.destinationStart && s.phase === 'active') {
      const request = s.destinationRequest;
      if (!request || s.startPermitted || event.pid !== request.pid || event.window !== request.window ||
          event.physicalDownEventNumber !== s.physicalDownEventNumber || typeof event.nonce !== 'string' || !/^45424453[0-9a-f]{8}$/u.test(event.nonce) ||
          !Number.isFinite(event.expiresUptimeMs) || event.expiresUptimeMs <= 0) {
        this.cancel('Destination start permit does not match the pending window'); return;
      }
      s.startPermitted = true;
      this.invoke(this.remote, { command: 'start-permitted', id: s.id, generation: s.generation, pid: event.pid,
        window: event.window, physicalDownEventNumber: event.physicalDownEventNumber, nonce: event.nonce,
        expiresUptimeMs: event.expiresUptimeMs });
    } else if (event.event === 'target-armed') s.targetArmed = true;
    else if (event.event === 'target-ended-verified' && this.verifyTargetEnd && s.pendingEnd && s.phase !== 'cancelling') {
      s.endVerified = true;
      if (s.phase === 'finishing') this.received(s.pendingEnd);
    } else if (event.event === 'ended') {
      if (s.phase !== 'active') { this.cancel('Physical release before destination activation'); return; }
      s.phase = 'finishing'; this.arm();
      this.invoke(this.remote, { command: 'release', id: s.id, generation: s.generation });
      if (s.pendingEnd) this.received(s.pendingEnd);
    }
  }
  received(event) {
    const s = this.session;
    if (!s || event.id !== s.id || event.generation !== s.generation) return;
    if (event.event === 'prepared' && s.phase === 'preparing-target') {
      s.phase = 'ready'; clearTimeout(this.timer);
      this.invoke(this.route, { command: 'ready', id: s.id, generation: s.generation });
    } else if (event.event === 'destination-start-request' && this.destinationStart && s.phase === 'active') {
      if (s.destinationRequest) { this.cancel('Duplicate destination start request'); return; }
      if (!Number.isInteger(event.pid) || event.pid < 1 || event.pid > 0x7fffffff ||
          !Number.isInteger(event.window) || event.window < 1 || event.window > 0x7fffffff ||
          event.physicalDownEventNumber !== s.physicalDownEventNumber) {
        this.cancel('Invalid destination start window or physical event number'); return;
      }
      s.destinationRequest = { pid: event.pid, window: event.window }; this.arm();
      this.invoke(this.route, { command: 'destination-start', id: s.id, generation: s.generation,
        pid: event.pid, window: event.window, physicalDownEventNumber: event.physicalDownEventNumber });
    } else if (event.event === 'drag-loop-running') {
      if (this.destinationStart && s.phase === 'active' && !s.startPermitted) { this.cancel('Native drag started without a destination permit'); return; }
      s.loopObserved = true;
      if (this.destinationStart && s.phase === 'active') clearTimeout(this.timer);
      if (this.targetStartAck && s.phase === 'active') this.invoke(this.route, { command: 'target-started', id: s.id, generation: s.generation });
    }
    else if (event.event === 'target-entered') {
      try { if (BigInt(event.hwnd) !== 0n) s.targetObserved = true; } catch { /* malformed/null HWND is not a target */ }
    }
    else if (event.event === 'ended') {
      if (this.verifyTargetEnd && event.accepted === true && event.copied === true && !s.endVerified && (s.phase === 'active' || s.phase === 'finishing')) {
        if (!Number.isFinite(event.nativeEndedUptimeMs) || event.nativeEndedUptimeMs <= 0) { this.cancel('Missing native monotonic end timestamp'); return; }
        s.pendingEnd = event;
        if (!s.verificationRequested) {
          s.verificationRequested = true;
          this.invoke(this.route, { command: 'target-ended', id: s.id, generation: s.generation, nativeEndedUptimeMs: event.nativeEndedUptimeMs });
        }
        this.arm(); return;
      }
      // AppKit can finish on the real HID up before the router's event queue reports it.
      if (s.phase === 'active' && event.accepted === true && event.copied === true) {
        if (!this.targetStartAck) { this.cancel('Native drop completed before the authoritative release'); return; }
        s.pendingEnd = event; this.arm(); return;
      }
      const accepted = s.phase === 'finishing' && event.accepted === true && event.copied === true && s.loopObserved === true && (!this.requireTargetNotification || s.targetObserved === true);
      if (s.phase !== 'finishing' && s.phase !== 'cancelling') this.invoke(this.route, { command: 'cancel', id: s.id, generation: s.generation });
      this.invoke(this.route, { command: 'finish', id: s.id, generation: s.generation });
      this.invoke(this.native, { command: 'reset', id: s.id });
      clearTimeout(this.timer); this.session = undefined; this.retire(s.id);
      this.emit('result', { id: s.id, generation: s.generation, accepted,
        nativeAccepted: event.accepted === true, loopObserved: s.loopObserved === true, targetObserved: s.targetObserved === true,
        destinationVerified: false, experiment: this.allowSelection ? 'verified-file-transfer' : 'pre-positioned-fixture',
        error: s.cancelReason || event.error || (!accepted && event.accepted === true ? 'Native target observation incomplete; verify actual destination separately' : undefined) });
    }
  }
  cancel(reason = 'Coordinator stopped') {
    const s = this.session; if (!s || s.phase === 'cancelling') return;
    clearTimeout(this.timer); s.phase = 'cancelling'; s.cancelReason = reason;
    this.emit('cancelling', { id: s.id, generation: s.generation, reason });
    const command = { command: 'cancel', id: s.id, ...(s.generation ? { generation: s.generation } : {}) };
    for (const [fn, message] of [[this.route, command], [this.remote, command], [this.native, { command: 'reset', id: s.id }]]) {
      Promise.resolve().then(() => fn(message)).catch(() => {});
    }
    const finish = () => {
      if (this.session !== s) return;
      this.session = undefined; this.retire(s.id);
      if (s.generation) Promise.resolve(this.route({ command: 'finish', id: s.id, generation: s.generation })).catch(() => {});
      this.emit('result', { id: s.id, accepted: false, experiment: this.allowSelection ? 'verified-file-transfer' : 'pre-positioned-fixture', error: reason });
    };
    if (s.generation && !s.pendingEnd) this.timer = setTimeout(finish, this.timeout);
    else finish();
  }
  retire(id) { this.retired.add(id); if (this.retired.size > 32) this.retired.delete(this.retired.values().next().value); }
}
