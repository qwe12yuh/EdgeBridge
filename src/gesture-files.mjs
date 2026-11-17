// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import { collect } from './files.mjs';
import { createReceiver, send } from './transport.mjs';

export const DRAG_BYTES = 64 * 1024 * 1024;
export function sameGesture(context, session) {
  return Boolean(context && session && context.gestureId === session.id && context.generation === session.generation);
}
export async function cleanupStagedBatch(inbox, paths) {
  if (!inbox || !Array.isArray(paths) || !paths.length || typeof paths[0] !== 'string') return false;
  const root = path.resolve(inbox), folder = path.dirname(path.resolve(paths[0]));
  if (path.dirname(folder) !== root || !path.basename(folder).startsWith('incoming-')) return false;
  await fs.rm(folder, { recursive: true, force: true });
  return true;
}
export async function pruneStagedInbox(inbox, { maxAgeMs = 15 * 60 * 1000, activeFolder } = {}) {
  if (!inbox) return 0;
  const root = path.resolve(inbox), active = activeFolder ? path.resolve(activeFolder) : undefined;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('incoming-')) continue;
    const candidate = path.join(root, entry.name);
    if (candidate === active) continue;
    try {
      const stat = await fs.stat(candidate);
      if (now - stat.mtimeMs >= maxAgeMs) {
        await fs.rm(candidate, { recursive: true, force: true });
        removed++;
      }
    } catch { /* ignore concurrent removal */ }
  }
  return removed;
}
export async function selectedFiles(peer, paths, context, { signal, maxBytes = DRAG_BYTES } = {}) {
  signal?.throwIfAborted();
  const manifest = await collect(paths);
  signal?.throwIfAborted();
  const bytes = manifest.entries.reduce((total, entry) => total + (entry.kind === 'file' ? entry.size : 0), 0);
  if (bytes > maxBytes) throw Error('Current full-staging drag limit is 64 MiB');
  const result = await send(peer, manifest, { signal, context });
  if (result.handoff?.staged !== true) throw Error(result.handoff?.error || 'Gesture ended before native preparation');
  return { bytes, files: manifest.sources.size, result };
}
export async function gestureInbox(config, { authorized, verified }) {
  await pruneStagedInbox(config.inbox).catch(() => {});
  const server = await createReceiver({ cert: await fs.readFile(config.certificate), key: await fs.readFile(config.key),
    token: config.token, inbox: config.inbox,
    validateContext: (context, { entries }) => {
      if (!context || typeof context.gestureId !== 'string' || !Number.isInteger(context.generation) || !authorized(context)) throw Error('Gesture expired or upload not requested');
      if (entries.reduce((total, entry) => total + (entry.kind === 'file' ? entry.size : 0), 0) > (config.maxBytes || DRAG_BYTES)) throw Error('Current full-staging drag limit is 64 MiB');
    },
    onReceived: async (paths, context) => {
      if (!authorized(context)) {
        await cleanupStagedBatch(config.inbox, paths).catch(() => {});
        throw Error('Gesture ended before native preparation');
      }
      try {
        await verified(paths, context);
        return { staged: true };
      } catch (error) {
        await cleanupStagedBatch(config.inbox, paths).catch(() => {});
        throw error;
      }
    },
  });
  return server;
}
