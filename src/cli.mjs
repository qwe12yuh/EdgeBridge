// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { collect } from './files.mjs';
import { createReceiver, send } from './transport.mjs';
import { checkConfig, loadReceiverConfig } from './config-check.mjs';
import { DRAG_BYTES } from './gesture-files.mjs';
import { createPairingDirectory, generateCertPair, initTransferPair, pairReceivers } from './pairing.mjs';

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
  } else if (command === 'init-pair') {
    if (args.length !== 1) throw Error('init-pair requires a new private directory');
    const folder = await initTransferPair(args[0]);
    console.log(`Created a two-way file transfer pair in ${folder}. This does not enable native screen dragging. Keep both bundles private.`);
  } else if (['init-lab', 'init-windows-lab', 'init-mac-peer-lab'].includes(command)) {
    const windowsPair = command === 'init-windows-lab';
    const macPair = command === 'init-mac-peer-lab';
    const experiment = windowsPair ? 'windows-windows' : macPair ? 'macos-macos-source' : undefined;
    if (experiment && (!args[0] || !args[1] || !args[2] || args[1] === args[2])) {
      throw Error('Experimental pairing requires a new directory and two distinct Deskflow screen names');
    }
    const folder = await createPairingDirectory(args[0] || '.state-lab');
    const macName = args[1] || 'mac-peer', winName = args[2] || 'windows-peer';
    const macDir = path.join(folder, experiment ? 'primary' : 'mac'), winDir = path.join(folder, experiment ? 'secondary' : 'windows');
    await fs.mkdir(macDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(winDir, { recursive: true, mode: 0o700 });
    const control = await generateCertPair(winDir, 'control', 'EdgeBridge-Control');
    const controlCert = experiment ? 'secondary-control-cert.pem' : 'windows-control-cert.pem';
    const firstPeer = experiment ? 'primary-upload-peer.local.json' : 'mac-upload-peer.local.json';
    const secondPeer = experiment ? 'secondary-upload-peer.local.json' : 'windows-upload-peer.local.json';
    await fs.writeFile(path.join(macDir, controlCert), control.certPem, { mode: 0o600, flag: 'wx' });
    const controlToken = randomBytes(32).toString('hex');
    await pairReceivers({
      first: macDir, second: winDir, firstPort: 24814, secondPort: 24815,
      firstPeerFile: secondPeer, secondPeerFile: firstPeer,
      receiverFile: 'upload-receiver.local.json', maxBytes: DRAG_BYTES,
    });

    await fs.writeFile(path.join(macDir, experiment ? 'primary.local.json' : 'mac.local.json'), JSON.stringify({
      role: 'source', realFiles: true, ...(experiment ? { experiment } : {}), target: winName,
      ...(windowsPair ? { primaryName: macName, routeSocket: String.raw`\\.\pipe\edgebridge-gesture`, nativeHelper: './edgebridge-gesture-lab-win.exe' }
        : { macName, nativeIPC: './native', routeSocket: './route.sock' }),
      peerHost: '127.0.0.1', peerPort: 24813,
      peerCertificate: './' + controlCert, peerToken: controlToken,
      uploadReceiver: './upload-receiver.local.json', uploadPeer: './' + secondPeer,
    }, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.writeFile(path.join(winDir, experiment ? 'secondary.local.json' : 'windows.local.json'), JSON.stringify({
      role: 'destination', realFiles: true, ...(experiment ? { experiment } : {}), bind: '127.0.0.1', port: 24813,
      certificate: './control-cert.pem', key: './control-key.pem', token: controlToken,
      ...(macPair ? { nativeIPC: './native' } : { nativeHelper: './edgebridge-gesture-lab-win.exe' }),
      uploadReceiver: './upload-receiver.local.json', uploadPeer: './' + firstPeer,
    }, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(`Created paired ${experiment ? 'experimental primary/ and secondary/' : 'mac/ and windows/'} lab bundles in ${folder}. Keep all *.local.json and *-key.pem files private.`);
  } else if (command === 'serve') {
    const config = await loadReceiverConfig(args[0]);
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
  } else if (command === 'check') {
    if (!args[0]) throw Error('check requires a configuration file path');
    const summary = await checkConfig(args[0]);
    console.log(JSON.stringify({ event: 'config-valid', ...summary }));
  } else {
    console.log('EdgeBridge alpha\n  init <new-directory>\n  init-pair <new-private-directory>\n  init-lab <new-directory> [mac-name] [windows-name]\n  init-windows-lab <new-directory> <primary-name> <secondary-name>\n  init-mac-peer-lab <new-directory> <primary-name> <secondary-name>\n  serve <receiver.local.json>\n  send <peer.local.json> <files-or-folders...>\n  check <config.local.json>');
    if (command) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
