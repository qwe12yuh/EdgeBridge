// SPDX-License-Identifier: MIT
import tls from 'node:tls';
import { timingSafeEqual, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { JsonLines } from './json-lines.mjs';

export async function connectControl({ host, port, certificate, token }) {
  const fingerprint = new X509Certificate(certificate).fingerprint256;
  const socket = tls.connect({ host, port, ca: certificate, minVersion: 'TLSv1.3',
    checkServerIdentity: (_name, cert) => cert.fingerprint256 === fingerprint ? undefined : Error('Certificate pin mismatch') });
  socket.setNoDelay(true); socket.setTimeout(3000, () => socket.destroy(Error('Control lease expired')));
  await once(socket, 'secureConnect');
  const link = new JsonLines(socket);
  await link.send({ command: 'hello', protocol: 1, token });
  return link;
}
export function createControlServer({ cert, key, token, onConnection }) {
  if (typeof token !== 'string' || token.length < 32) throw Error('Control pairing token is too short');
  const server = tls.createServer({ cert, key, minVersion: 'TLSv1.3', handshakeTimeout: 3000 }, socket => {
    socket.setNoDelay(true); socket.setTimeout(3000, () => socket.destroy(Error('Control lease expired')));
    const link = new JsonLines(socket); let authenticated = false;
    // Never emit an unhandled EventEmitter error when an unauthenticated peer drops.
    link.on('failure', () => {});
    link.on('message', message => {
      if (authenticated) return;
      const actual = Buffer.from(typeof message.token === 'string' ? message.token : '');
      const expected = Buffer.from(token);
      if (message.command !== 'hello' || message.protocol !== 1 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        socket.destroy(); return;
      }
      authenticated = true; onConnection(link);
      void link.send({ event: 'hello', protocol: 1 }).catch(() => socket.destroy());
    });
  });
  server.maxConnections = 2;
  return server;
}
