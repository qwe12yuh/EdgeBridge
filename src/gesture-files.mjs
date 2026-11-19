// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import { collect } from './files.mjs';
import { createReceiver, send } from './transport.mjs';

export const DRAG_BYTES = 64 * 1024 * 1024;
export function sameGesture(context, session) {
  return Boolean(context && session && context.gestureId === session.id && context.generation === session.generation);
}
export function stagedFolderFromPaths(inbox, paths) {
  if (!inbox || !Array.isArray(paths) || !paths.length) return undefined;
  const root = path.resolve(inbox);
  let batch;
  for (const item of paths) {
    if (typeof item !== 'string' || !item) return undefined;
    const rel = path.relative(root, path.resolve(item));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const parts = rel.split(path.sep);
    if (parts.length < 2 || !parts[0].startsWith('incoming-')) return undefined;
    if (batch === undefined) batch = parts[0];
    else if (batch !== parts[0]) return undefined;
  }
  return path.join(root, batch);
}
export async function cleanupStagedBatch(inbox, paths, { onError } = {}) {
  const folder = stagedFolderFromPaths(inbox, paths);
  if (!folder) return false;
  try {
    await fs.rm(folder, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') onError?.(error);
    return false;
  }
}
async function inspectBatchTree(folder) {
  const rootStat = await fs.lstat(folder);
  if (!rootStat.isDirectory()) return { latestMtimeMs: rootStat.mtimeMs, inProgress: false };
  let latestMtimeMs = rootStat.mtimeMs, inProgress = false;
  const queue = [folder];
  while (queue.length) {
    const current = queue.pop();
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (child.name.startsWith('.edgebridge-part-')) return { latestMtimeMs, inProgress: true };
      const full = path.join(current, child.name);
      const stat = await fs.lstat(full);
      if (stat.mtimeMs > latestMtimeMs) latestMtimeMs = stat.mtimeMs;
      if (child.isDirectory()) queue.push(full);
    }
  }
  return { latestMtimeMs, inProgress };
}
export async function pruneStagedInbox(inbox, { maxAgeMs = 30 * 60 * 1000, activeFolder, activeFolders = [], onError } = {}) {
  if (!inbox) return 0;
  const root = path.resolve(inbox);
  const protectedFolders = new Set();
  if (activeFolder) protectedFolders.add(path.resolve(activeFolder));
  for (const item of activeFolders) {
    if (typeof item === 'string' && item) protectedFolders.add(path.resolve(item));
    else if (Array.isArray(item)) {
      const resolved = stagedFolderFromPaths(root, item);
      if (resolved) protectedFolders.add(resolved);
    }
  }
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error?.code !== 'ENOENT') onError?.(error);
    return 0;
  }
  let removed = 0;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('incoming-')) continue;
    const candidate = path.join(root, entry.name);
    if (protectedFolders.has(candidate)) continue;
    try {
      const { latestMtimeMs, inProgress } = await inspectBatchTree(candidate);
      if (!inProgress && now - latestMtimeMs >= maxAgeMs) {
        await fs.rm(candidate, { recursive: true, force: true });
        removed++;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') onError?.(error);
    }
  }
  return removed;
}
export async function selectedFiles(peer, paths, context, { signal, maxBytes = DRAG_BYTES } = {}) {
  signal?.throwIfAborted();
  const manifest = await collect(paths, { prehash: false });
  signal?.throwIfAborted();
  const bytes = manifest.entries.reduce((total, entry) => total + (entry.kind === 'file' ? entry.size : 0), 0);
  if (bytes > maxBytes) throw Error('Current full-staging drag limit is 64 MiB');
  const result = await send(peer, manifest, { signal, context });
  if (result.handoff?.staged !== true) throw Error(result.handoff?.error || 'Gesture ended before native preparation');
  return { bytes, files: manifest.sources.size, result };
}
export async function gestureInbox(config, { authorized, verified, activePaths = () => [], onCleanupError,
  pruneIntervalMs = 5 * 60 * 1000, maxAgeMs = 30 * 60 * 1000 }) {
  await pruneStagedInbox(config.inbox, { maxAgeMs, activeFolders: activePaths(), onError: onCleanupError });
  const server = await createReceiver({ cert: await fs.readFile(config.certificate), key: await fs.readFile(config.key),
    token: config.token, inbox: config.inbox,
    validateContext: (context, { entries }) => {
      if (!context || typeof context.gestureId !== 'string' || !Number.isInteger(context.generation) || !authorized(context)) throw Error('Gesture expired or upload not requested');
      if (entries.reduce((total, entry) => total + (entry.kind === 'file' ? entry.size : 0), 0) > (config.maxBytes || DRAG_BYTES)) throw Error('Current full-staging drag limit is 64 MiB');
    },
    onReceived: async (paths, context) => {
      if (!authorized(context)) {
        await cleanupStagedBatch(config.inbox, paths, { onError: onCleanupError });
        throw Error('Gesture ended before native preparation');
      }
      try {
        await verified(paths, context);
        return { staged: true };
      } catch (error) {
        await cleanupStagedBatch(config.inbox, paths, { onError: onCleanupError });
        throw error;
      }
    },
  });
  const timer = setInterval(() => {
    void pruneStagedInbox(config.inbox, { maxAgeMs, activeFolders: activePaths(), onError: onCleanupError });
  }, pruneIntervalMs).unref();
  server.on('close', () => clearInterval(timer));
  return server;
}
