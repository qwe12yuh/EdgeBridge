// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import { collect } from './files.mjs';
import { createReceiver, send } from './transport.mjs';

export const DRAG_BYTES = 64 * 1024 * 1024;
export function sameGesture(context, session) {
  return Boolean(context && session && context.gestureId === session.id && context.generation === session.generation);
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
  const server = await createReceiver({ cert: await fs.readFile(config.certificate), key: await fs.readFile(config.key),
    token: config.token, inbox: config.inbox,
    validateContext: (context, { entries }) => {
      if (!context || typeof context.gestureId !== 'string' || !Number.isInteger(context.generation) || !authorized(context)) throw Error('Gesture expired or upload not requested');
      if (entries.reduce((total, entry) => total + (entry.kind === 'file' ? entry.size : 0), 0) > (config.maxBytes || DRAG_BYTES)) throw Error('Current full-staging drag limit is 64 MiB');
    },
    onReceived: async (paths, context) => {
      if (!authorized(context)) throw Error('Gesture ended before native preparation');
      await verified(paths, context); return { staged: true };
    },
  });
  return server;
}
