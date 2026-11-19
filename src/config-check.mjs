// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { DRAG_BYTES } from './gesture-files.mjs';

const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535;
const validToken = token => typeof token === 'string' && token.length >= 32 && !/^(REPLACE_WITH_|CHANGE_ME|EXAMPLE_|TODO)/iu.test(token);
export const resolveFrom = (baseDir, targetPath) => path.isAbsolute(targetPath) || path.win32.isAbsolute(targetPath)
  ? targetPath
  : path.resolve(baseDir, targetPath);

export async function readConfigJson(filePath, label = 'Configuration') {
  const resolved = path.resolve(filePath);
  let raw;
  try { raw = await fs.readFile(resolved, 'utf8'); }
  catch (error) { throw Error(`${label} cannot be read (${resolved}): ${error.message}`); }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Root must be a JSON object');
    return { resolved, baseDir: path.dirname(resolved), config: parsed };
  } catch (error) { throw Error(`${label} is not valid JSON (${resolved}): ${error.message}`); }
}

export async function loadReceiverConfig(filePath) {
  const { baseDir, config } = await readConfigJson(filePath, 'Receiver configuration');
  return {
    ...config,
    ...(config.inbox ? { inbox: resolveFrom(baseDir, config.inbox) } : {}),
    ...(config.certificate ? { certificate: resolveFrom(baseDir, config.certificate) } : {}),
    ...(config.key ? { key: resolveFrom(baseDir, config.key) } : {}),
    ...(config.nativeHelper ? { nativeHelper: resolveFrom(baseDir, config.nativeHelper) } : {}),
  };
}

function parseCertPem(pem, label) {
  let cert;
  try { cert = new X509Certificate(pem); }
  catch (error) { throw Error(`${label} is not a valid X.509 PEM certificate: ${error.message}`); }
  const now = Date.now(), validTo = Date.parse(cert.validTo);
  if (Number.isFinite(validTo) && validTo <= now) throw Error(`${label} certificate expired at ${cert.validTo}`);
  return cert;
}

async function checkCertFile(certPath, label) {
  const pem = await fs.readFile(certPath, 'utf8').catch(error => {
    throw Error(`${label} certificate file unreadable (${certPath}): ${error.message}`);
  });
  return parseCertPem(pem, `${label} (${certPath})`);
}

async function checkCertAndKeyPair(certPath, keyPath, label) {
  const cert = await checkCertFile(certPath, label);
  const keyPem = await fs.readFile(keyPath, 'utf8').catch(error => {
    throw Error(`${label} private key unreadable (${keyPath}): ${error.message}`);
  });
  let key;
  try { key = createPrivateKey(keyPem); }
  catch (error) { throw Error(`${label} is not a valid private key (${keyPath}): ${error.message}`); }
  if (!cert.checkPrivateKey(key)) throw Error(`${label} certificate and private key do not match`);
  const warnings = [];
  if (process.platform !== 'win32') {
    const stat = await fs.stat(keyPath);
    if ((stat.mode & 0o077) !== 0) {
      warnings.push(`Private key ${keyPath} has group/other permissions (${(stat.mode & 0o777).toString(8)}); recommend chmod 600`);
    }
  }
  return { subject: cert.subject, fingerprint256: cert.fingerprint256, validTo: cert.validTo, warnings };
}

export async function checkConfig(configPath, visited = new Set()) {
  if (!configPath) throw Error('Configuration file path is required');
  const { resolved, baseDir, config } = await readConfigJson(configPath, 'Configuration');
  if (visited.has(resolved)) throw Error(`Circular configuration reference detected: ${resolved}`);
  visited.add(resolved);
  if (config.stagingTimeoutMs !== undefined && (!Number.isInteger(config.stagingTimeoutMs) || config.stagingTimeoutMs < 1 || config.stagingTimeoutMs > 4800)) {
    throw Error("stagingTimeoutMs must be a positive integer ≤ 4800, below the router's 5 s prepare deadline");
  }

  if (config.role === 'source') {
    for (const key of ['macName', 'target', 'nativeIPC', 'routeSocket', 'peerPort', 'peerCertificate', 'peerToken']) {
      if (!config[key]) throw Error(`Source configuration missing required field: ${key}`);
    }
    if (!validPort(config.peerPort)) throw Error('Source peerPort must be an integer in 1..65535');
    if (!validToken(config.peerToken)) throw Error('Source peerToken must be at least 32 characters and not a placeholder');
    const peerCert = await checkCertFile(resolveFrom(baseDir, config.peerCertificate), 'Source peerCertificate');
    const details = { kind: 'gesture-source', mode: config.realFiles === true ? 'verified-file-transfer' : 'pre-positioned-fixture',
      macName: config.macName, target: config.target, peerPort: config.peerPort, peerFingerprint256: peerCert.fingerprint256 };
    if (config.realFiles === true) {
      if (!config.uploadReceiver || !config.uploadPeer) throw Error('Real-file source configuration requires uploadReceiver and uploadPeer');
      details.uploadReceiver = await checkConfig(resolveFrom(baseDir, config.uploadReceiver), new Set(visited));
      details.uploadPeer = await checkConfig(resolveFrom(baseDir, config.uploadPeer), new Set(visited));
    } else if (!config.fixture || !/^[a-f0-9]{64}$/iu.test(config.fixtureHash || '')) {
      throw Error('Fixture source configuration requires fixture and 64-hex fixtureHash');
    }
    return details;
  }

  if (config.role === 'destination') {
    for (const key of ['port', 'certificate', 'key', 'token', 'nativeHelper']) {
      if (!config[key]) throw Error(`Destination configuration missing required field: ${key}`);
    }
    if (!validPort(config.port)) throw Error('Destination port must be an integer in 1..65535');
    if (!validToken(config.token)) throw Error('Destination token must be at least 32 characters and not a placeholder');
    const pair = await checkCertAndKeyPair(resolveFrom(baseDir, config.certificate), resolveFrom(baseDir, config.key), 'Destination');
    const details = { kind: 'gesture-destination', mode: config.realFiles === true ? 'verified-file-transfer' : 'pre-positioned-fixture',
      bind: config.bind || '127.0.0.1', port: config.port, fingerprint256: pair.fingerprint256,
      ...(pair.warnings.length ? { warnings: pair.warnings } : {}) };
    if (config.realFiles === true) {
      if (!config.uploadReceiver || !config.uploadPeer) throw Error('Real-file destination configuration requires uploadReceiver and uploadPeer');
      details.uploadReceiver = await checkConfig(resolveFrom(baseDir, config.uploadReceiver), new Set(visited));
      details.uploadPeer = await checkConfig(resolveFrom(baseDir, config.uploadPeer), new Set(visited));
    } else if (!config.fixture || !/^[a-f0-9]{64}$/iu.test(config.fixtureHash || '')) {
      throw Error('Fixture destination configuration requires fixture and 64-hex fixtureHash');
    }
    return details;
  }

  if (typeof config.baseURL === 'string') {
    let url;
    try { url = new URL(config.baseURL); } catch { throw Error('Peer baseURL is not a valid URL'); }
    if (url.protocol !== 'https:') throw Error('Peer baseURL must use https://');
    if (!validToken(config.token)) throw Error('Peer token must be at least 32 characters and not a placeholder');
    if (typeof config.certificate !== 'string' || !config.certificate.trim()) throw Error('Peer certificate PEM is required');
    const cert = parseCertPem(config.certificate, 'Peer certificate');
    return { kind: 'transport-peer', baseURL: config.baseURL, fingerprint256: cert.fingerprint256 };
  }

  if ('inbox' in config || 'certificate' in config || 'key' in config || 'port' in config) {
    for (const key of ['inbox', 'port', 'token', 'certificate', 'key']) {
      if (!config[key]) throw Error(`Receiver configuration missing required field: ${key}`);
    }
    if (!validPort(config.port)) throw Error('Receiver port must be an integer in 1..65535');
    if (!validToken(config.token)) throw Error('Receiver token must be at least 32 characters and not a placeholder');
    if (config.maxBytes !== undefined && (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1 || config.maxBytes > DRAG_BYTES)) {
      throw Error(`Gesture receiver maxBytes must be between 1 and ${DRAG_BYTES}`);
    }
    const pair = await checkCertAndKeyPair(resolveFrom(baseDir, config.certificate), resolveFrom(baseDir, config.key), 'Receiver');
    return { kind: 'transport-receiver', bind: config.bind || '127.0.0.1', port: config.port, fingerprint256: pair.fingerprint256,
      ...(pair.warnings.length ? { warnings: pair.warnings } : {}) };
  }

  throw Error('Unrecognized configuration schema: expected source, destination, transport-receiver or transport-peer');
}
