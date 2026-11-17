// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { collect } from './files.mjs';
import { createReceiver, send } from './transport.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'init') {
    const folder = path.resolve(args[0] || '.state');
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    // Refuse to replace pairing material.
    if ((await fs.readdir(folder)).length) throw Error('Use a new empty directory');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
      '-subj', '/CN=EdgeBridge', '-keyout', path.join(folder, 'key.pem'), '-out', path.join(folder, 'cert.pem')], { stdio: 'ignore' });
    await fs.chmod(path.join(folder, 'key.pem'), 0o600);
    const token = randomBytes(32).toString('hex');
    const receiver = { bind: '127.0.0.1', port: 24810, token, inbox: path.join(folder, 'inbox'),
      certificate: path.join(folder, 'cert.pem'), key: path.join(folder, 'key.pem') };
    const peer = { baseURL: 'https://127.0.0.1:24810', token, certificate: await fs.readFile(receiver.certificate, 'utf8') };
    await fs.writeFile(path.join(folder, 'receiver.local.json'), JSON.stringify(receiver, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.writeFile(path.join(folder, 'peer.local.json'), JSON.stringify(peer, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(`Created pairing files in ${folder}. Keep peer.local.json private; it authorizes file delivery.`);
  } else if (command === 'serve') {
    const config = JSON.parse(await fs.readFile(args[0], 'utf8'));
    const server = await createReceiver({
      cert: await fs.readFile(config.certificate), key: await fs.readFile(config.key),
      token: config.token, inbox: config.inbox,
      onReceived: async paths => {
        console.log(JSON.stringify({ event: 'received', paths }));
        if (config.nativeHelper) {
          // Only a locally configured executable may run; the peer cannot supply a command.
          const child = spawn(config.nativeHelper, paths, { stdio: 'inherit', windowsHide: false });
          child.on('error', error => console.error(`Native handoff: ${error.message}`));
        }
      },
    });
    server.on('notificationError', error => console.error(error.message));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.bind, resolve); });
    console.log(`Listening on ${config.bind}:${server.address().port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  } else if (command === 'send') {
    if (args.length < 2) throw Error('send requires peer configuration and file paths');
    const peer = JSON.parse(await fs.readFile(args[0], 'utf8'));
    const result = await send(peer, await collect(args.slice(1)));
    console.log(JSON.stringify({ event: 'verified-copy', ...result }));
  } else {
    console.log('EdgeBridge alpha\n  init <new-directory>\n  serve <receiver.local.json>\n  send <peer.local.json> <files-or-folders...>');
    if (command) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
