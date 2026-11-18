import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export async function createPairingDirectory(folder) {
  const root = path.resolve(folder);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(root);
  if (!info.isDirectory() || (await fs.readdir(root)).length) throw Error('Use a new empty directory');
  if (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077))) {
    throw Error('The pairing directory must be owned by you and private (mode 0700)');
  }
  return root;
}

export const writePrivateJson = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });

export async function generateCertPair(folder, prefix, commonName) {
  const keyFile = path.join(folder, `${prefix}-key.pem`), certFile = path.join(folder, `${prefix}-cert.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
    '-subj', `/CN=${commonName}`, '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  await fs.chmod(keyFile, 0o600);
  return { keyFile, certFile, certPem: await fs.readFile(certFile, 'utf8') };
}

export async function pairReceivers({
  first, second, firstPort, secondPort, firstPeerFile, secondPeerFile,
  receiverFile = 'receiver.local.json', maxBytes,
}) {
  async function prepare(folder, peerFolder, port, label, peerFile) {
    const { certPem } = await generateCertPair(folder, 'upload', label);
    const token = randomBytes(32).toString('hex');
    await writePrivateJson(path.join(folder, receiverFile), {
      bind: '127.0.0.1', port, token, inbox: './inbox',
      certificate: './upload-cert.pem', key: './upload-key.pem',
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
    await writePrivateJson(path.join(peerFolder, peerFile), {
      baseURL: `https://127.0.0.1:${port}`, token, certificate: certPem,
    });
  }
  await prepare(first, second, firstPort, 'EdgeBridge-First-Upload', secondPeerFile);
  await prepare(second, first, secondPort, 'EdgeBridge-Second-Upload', firstPeerFile);
}

export async function initTransferPair(folder) {
  const root = await createPairingDirectory(folder);
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  await fs.mkdir(first, { mode: 0o700 });
  await fs.mkdir(second, { mode: 0o700 });
  await pairReceivers({
    first, second, firstPort: 24817, secondPort: 24818,
    firstPeerFile: 'peer.local.json', secondPeerFile: 'peer.local.json',
  });
  return root;
}
