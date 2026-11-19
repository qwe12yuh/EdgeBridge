// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

export const LIMITS = { entries: 1000, bytes: 1024 ** 3, sessions: 8 };
export function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.length > 2000) throw Error(`Invalid name: ${name}`);
  const parts = name.split('/');
  if (parts.length > 32 || parts.some(s => !s || s === '.' || s === '..' ||
    /[<>:"\\|?*\x00-\x1f]/u.test(s) || /[. ]$/u.test(s) || s.length > 200 ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(s))) throw Error(`Unsafe name: ${name}`);
  return parts.join('/');
}
export function validateManifest(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > LIMITS.entries) throw Error('Entry limit');
  const seen = new Map(); let bytes = 0;
  for (const e of entries) {
    const name = safeRelative(e.name), key = name.normalize('NFC').toLowerCase();
    if (seen.has(key) || !['file', 'directory'].includes(e.kind)) throw Error(`Name collision or invalid kind: ${name}`);
    if (e.kind === 'file') {
      if (!Number.isSafeInteger(e.size) || e.size < 0 || ('sha256' in e && (typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(e.sha256)))) throw Error('Invalid file metadata');
      bytes += e.size;
      if (bytes > LIMITS.bytes) throw Error('Byte limit');
    }
    seen.set(key, e.kind);
  }
  for (const name of seen.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.get(parts.slice(0, i).join('/')) !== 'directory') throw Error(`Missing directory or file ancestor: ${name}`);
    }
  }
  return entries;
}
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function mappedName(name) {
  const forbidden = '<>:"\\|?*', replacements = '＜＞：＂＼｜？＊';
  return name.normalize('NFC').replace(/[<>:"\\|?*]/gu, char => replacements[forbidden.indexOf(char)])
    .replace(/[\x00-\x1f]/gu, '_').replace(/[. ]+$/u, suffix => suffix.replace(/\./gu, '．').replace(/ /gu, '　'))
    .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?=\.|$)/iu, '$1_');
}
export async function collect(paths, { prehash = true } = {}) {
  const entries = [], sources = new Map();
  async function walk(file, parent, used) {
    const stat = await fs.lstat(file);
    const mapped = mappedName(path.basename(file)), extension = stat.isFile() ? path.extname(mapped) : '';
    const stem = extension ? mapped.slice(0, -extension.length) : mapped;
    let component = mapped, number = 2;
    while (used.has(component.normalize('NFC').toLowerCase())) component = `${stem} (${number++})${extension}`;
    used.add(component.normalize('NFC').toLowerCase());
    const name = parent ? `${parent}/${component}` : component;
    safeRelative(name);
    if (stat.isSymbolicLink()) throw Error('Symbolic links are not supported');
    if (entries.length >= LIMITS.entries) throw Error('Entry limit');
    if (stat.isDirectory()) {
      entries.push({ name, kind: 'directory' });
      const children = new Set();
      for (const child of (await fs.readdir(file)).sort()) await walk(path.join(file, child), name, children);
    } else if (stat.isFile()) {
      if (stat.size > LIMITS.bytes) throw Error('Byte limit');
      sources.set(entries.length, file);
      entries.push({ name, kind: 'file', size: stat.size, ...(prehash ? { sha256: await sha256(file) } : {}) });
    } else throw Error('Unsupported file type');
  }
  const tops = new Set();
  for (const file of paths) await walk(path.resolve(file), '', tops);
  validateManifest(entries);
  return { entries, sources };
}
