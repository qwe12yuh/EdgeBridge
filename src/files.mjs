// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

export const LIMITS = { entries: 1000, bytes: 1024 ** 3, sessions: 8 };
export function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.length > 2000) throw Error('Invalid name');
  const parts = name.split('/');
  if (parts.length > 32 || parts.some(s => !s || s === '.' || s === '..' ||
    /[<>:"\\|?*\x00-\x1f]/u.test(s) || /[. ]$/u.test(s) || s.length > 200 ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(s))) throw Error('Unsafe name');
  return parts.join('/');
}
export function validateManifest(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > LIMITS.entries) throw Error('Entry limit');
  const seen = new Map(); let bytes = 0;
  for (const e of entries) {
    const name = safeRelative(e.name), key = name.normalize('NFC').toLowerCase();
    if (seen.has(key) || !['file', 'directory'].includes(e.kind)) throw Error('Name collision or invalid kind');
    if (e.kind === 'file') {
      if (!Number.isSafeInteger(e.size) || e.size < 0 || !/^[a-f0-9]{64}$/u.test(e.sha256)) throw Error('Invalid file metadata');
      bytes += e.size;
      if (bytes > LIMITS.bytes) throw Error('Byte limit');
    }
    seen.set(key, e.kind);
  }
  for (const name of seen.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.get(parts.slice(0, i).join('/')) !== 'directory') throw Error('Missing directory or file ancestor');
    }
  }
  return entries;
}
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function collect(paths) {
  const entries = [], sources = new Map();
  async function walk(file, name) {
    safeRelative(name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw Error('Symbolic links are not supported');
    if (entries.length >= LIMITS.entries) throw Error('Entry limit');
    if (stat.isDirectory()) {
      entries.push({ name, kind: 'directory' });
      for (const child of (await fs.readdir(file)).sort()) await walk(path.join(file, child), `${name}/${child}`);
    } else if (stat.isFile()) {
      if (stat.size > LIMITS.bytes) throw Error('Byte limit');
      sources.set(entries.length, file);
      entries.push({ name, kind: 'file', size: stat.size, sha256: await sha256(file) });
    } else throw Error('Unsupported file type');
  }
  for (const file of paths) await walk(path.resolve(file), path.basename(path.resolve(file)));
  validateManifest(entries);
  return { entries, sources };
}
