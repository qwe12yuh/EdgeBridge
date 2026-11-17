// SPDX-License-Identifier: MIT
import { EventEmitter } from 'node:events';
export class JsonLines extends EventEmitter {
  constructor(stream, limit = 65536) {
    super(); this.stream = stream; let pending = Buffer.alloc(0);
    stream.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.includes(10)) {
        const end = pending.indexOf(10), line = pending.subarray(0, end); pending = pending.subarray(end + 1);
        if (line.length > limit) { stream.destroy(Error('JSON frame too large')); return; }
        try {
          const value = JSON.parse(line.toString('utf8'));
          if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('Expected JSON object');
          this.emit('message', value);
        } catch (error) { stream.destroy(error); return; }
      }
      if (pending.length > limit) stream.destroy(Error('JSON frame too large'));
    });
    stream.on('error', error => this.emit('failure', error));
    stream.on('close', () => this.emit('closed'));
  }
  send(value) {
    const line = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(line) > 65536) return Promise.reject(Error('JSON frame too large'));
    return new Promise((resolve, reject) => {
      if (!this.stream.writable || this.stream.destroyed) return reject(Error('Control connection closed'));
      this.stream.write(line, error => error ? reject(error) : resolve());
    });
  }
}
