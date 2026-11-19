// SPDX-License-Identifier: MIT
import https from 'node:https';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { LIMITS, validateManifest } from './files.mjs';

const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
async function jsonBody(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length; if (length > 512 * 1024) throw Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function createReceiver({ cert, key, token, inbox, onReceived = () => {}, validateContext }) {
  if (typeof token !== 'string' || token.length < 32) throw Error('Pairing token is too short');
  await fs.mkdir(inbox, { recursive: true, mode: 0o700 });
  const sessions = new Map();
  let pendingOffers = 0;
  const checkContext = async (context, entries, phase) => {
    if (validateContext && await validateContext(context, { entries, phase }) === false) throw Error('Transfer context rejected');
  };
  const server = https.createServer({ cert, key, minVersion: 'TLSv1.3' }, async (req, res) => {
    const reply = (status, value) => { if (!res.destroyed && !res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); } };
    if (!equal(req.headers.authorization || '', `Bearer ${token}`)) { reply(401, { error: 'Unauthorized' }); req.resume(); return; }
    try {
      const url = new URL(req.url, 'https://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return reply(200, { protocol: 1 });
      if (req.method === 'POST' && url.pathname === '/offer') {
        // Reserve before body parsing or async policy checks can yield.
        if (sessions.size + pendingOffers >= LIMITS.sessions) throw Error('Session limit');
        pendingOffers++;
        try {
          const offer = await jsonBody(req);
          const entries = validateManifest(offer.entries), context = offer.context;
          await checkContext(context, entries, 'offer');
          const id = randomUUID(), folder = await fs.mkdtemp(path.join(inbox, 'incoming-'));
          sessions.set(id, { entries, context, folder, created: Date.now(), complete: new Set(), busy: new Set(), committed: false });
          return reply(201, { id });
        } finally { pendingOffers--; }
      }
      const match = /^\/session\/([a-f0-9-]+)\/(file\/([0-9]+)|commit)$/u.exec(url.pathname);
      if (!match || req.method !== 'POST') return reply(404, { error: 'Not found' });
      const s = sessions.get(match[1]);
      if (!s || s.committed) throw Error('Session unavailable');
      if (match[2] === 'commit') {
        if (s.busy.size || s.entries.some((e, i) => e.kind === 'file' && !s.complete.has(i))) throw Error('Incomplete transfer');
        s.committed = true; // reserve synchronously so concurrent commits cannot notify twice
        try {
          for (const e of s.entries.filter(e => e.kind === 'directory')) await fs.mkdir(path.join(s.folder, e.name), { recursive: true, mode: 0o700 });
        } catch (error) { s.committed = false; throw error; }
        const tops = [...new Set(s.entries.map(e => e.name.split('/')[0]))].map(name => path.join(s.folder, name));
        // Recheck immediately before native notification: a physical gesture may
        // have ended while the upload or directory publication was in progress.
        try { await checkContext(s.context, s.entries, 'commit'); }
        catch (error) {
          sessions.delete(match[1]); // consume authorization, retain verified files
          throw error;
        }
        // Notification failures do not turn a committed copy into a failed transfer.
        let handoff;
        try { handoff = await onReceived(tops, s.context); } catch (error) { server.emit('notificationError', error); handoff = { copied: false, error: error.message }; }
        sessions.delete(match[1]);
        return reply(200, { paths: tops, ...(handoff && typeof handoff === 'object' ? { handoff } : {}) });
      }
      const i = Number(match[3]), e = s.entries[i];
      if (!e || e.kind !== 'file' || s.complete.has(i) || s.busy.has(i)) throw Error('File unavailable');
      s.busy.add(i);
      const tmp = path.join(s.folder, `.edgebridge-part-${randomUUID()}`), target = path.join(s.folder, e.name);
      try {
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const hash = createHash('sha256'); let count = 0;
        const guard = new Transform({ transform(chunk, encoding, next) {
          count += chunk.length;
          if (count > e.size) return next(Error('File exceeds declared size'));
          hash.update(chunk); next(null, chunk);
        } });
        await pipeline(req, guard, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
        const digest = hash.digest('hex'), trailer = req.trailers['x-edgebridge-sha256'];
        if (count !== e.size || (e.sha256 !== undefined && digest !== e.sha256) ||
            ((e.sha256 === undefined || trailer !== undefined) &&
              (typeof trailer !== 'string' || !/^[a-f0-9]{64}$/iu.test(trailer) || trailer.toLowerCase() !== digest))) throw Error('Integrity mismatch');
        await fs.link(tmp, target); // atomic publication; never replace an existing destination
        s.complete.add(i);
        return reply(200, { verified: true });
      } finally { s.busy.delete(i); await fs.rm(tmp, { force: true }); }
    } catch (error) { reply(400, { error: error.message }); req.resume(); }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  server.maxConnections = 16;
  const expiry = setInterval(() => {
    for (const [id, s] of sessions) {
      if (!s.committed && !s.busy.size && Date.now() - s.created > 30 * 60 * 1000) {
        sessions.delete(id); fs.rm(s.folder, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 60000).unref();
  server.on('close', () => clearInterval(expiry));
  return server;
}

export function request({ baseURL, certificate, token }, route, { body, file, signal } = {}) {
  const url = new URL(route, baseURL);
  if (url.protocol !== 'https:') return Promise.reject(Error('HTTPS required'));
  const expected = new X509Certificate(certificate).fingerprint256;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      signal,
      method: route === '/health' ? 'GET' : 'POST', ca: certificate, minVersion: 'TLSv1.3',
      checkServerIdentity: (_hostname, cert) => cert.fingerprint256 === expected ? undefined : Error('Certificate pin mismatch'),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': file ? 'application/octet-stream' : 'application/json',
        ...(file ? { Trailer: 'x-edgebridge-sha256' } : {}) },
    }, res => {
      let bytes = 0; const chunks = [];
      res.on('data', c => { bytes += c.length; if (bytes > 512 * 1024) res.destroy(Error('Response too large')); else chunks.push(c); });
      res.on('error', reject);
      res.on('end', () => {
        try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (res.statusCode >= 400) throw Error(value.error); resolve(value); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(Error('Transfer timed out')));
    if (file) {
      const hash = createHash('sha256');
      const hashing = new Transform({
        transform(chunk, encoding, next) { hash.update(chunk); next(null, chunk); },
        flush(next) { req.addTrailers({ 'x-edgebridge-sha256': hash.digest('hex') }); next(); },
      });
      pipeline(createReadStream(file), hashing, req).catch(reject);
    }
    else req.end(body ? JSON.stringify(body) : undefined);
  });
}

export async function send(peer, { entries, sources }, { signal, context } = {}) {
  validateManifest(entries);
  const { id } = await request(peer, '/offer', { body: { entries, ...(context === undefined ? {} : { context }) }, signal });
  for (const [index, file] of sources) await request(peer, `/session/${id}/file/${index}`, { file, signal });
  return request(peer, `/session/${id}/commit`, { body: {}, signal });
}
