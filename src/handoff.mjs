// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';

// Only a matching started -> ended sequence can acknowledge a desktop drop.
export class NativeHandoffs {
  constructor(write, { startTimeout = 2000, dropTimeout = 60000 } = {}) {
    this.write = write;
    this.startTimeout = startTimeout;
    this.dropTimeout = dropTimeout;
  }
  start(paths) {
    if (this.pending) return Promise.reject(Error('Another native drag is active'));
    const id = randomUUID();
    return new Promise(resolve => {
      this.pending = { id, resolve, started: false };
      this.arm(this.startTimeout, 'Native helper did not start the drag');
      // Reserve the session before writing: a helper may acknowledge immediately.
      Promise.resolve().then(() => this.pending?.id === id && this.write({ command: 'incoming', id, paths, time: Date.now() }))
        .catch(error => { if (this.pending?.id === id) this.finish({ copied: false, error: error.message }, true); });
    });
  }
  arm(delay, error) {
    clearTimeout(this.pending.timer);
    this.pending.timer = setTimeout(() => this.finish({ copied: false, error }, true), delay);
  }
  event(event) {
    const p = this.pending;
    if (!p || event.id !== p.id) return false;
    if (event.event === 'native-drag-started' && !p.started) {
      p.started = true;
      this.arm(this.dropTimeout, 'Native drop did not acknowledge completion');
      return true;
    }
    if (event.event !== 'native-drag-ended') return false;
    const copied = p.started && event.copied === true;
    this.finish({ copied, ...(!copied ? { error: event.error || 'Native drag cancelled or never started' } : {}) });
    return true;
  }
  finish(result, cancel = false) {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    clearTimeout(p.timer);
    if (cancel) Promise.resolve().then(() => this.write({ command: 'cancel', id: p.id })).catch(() => {});
    p.resolve({ id: p.id, ...result });
  }
  stop(reason = 'Bridge stopped') { this.finish({ copied: false, error: reason }, true); }
}
