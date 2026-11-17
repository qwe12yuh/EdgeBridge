// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { DRAG_BYTES } from './gesture-files.mjs';

const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535;
const validToken = token => typeof token === 'string' && token.length >= 32 && !/^REPLACE_WITH_/u.test(token);

async function readJson(filePath, label) {
  let raw;
  try { raw = await fs.readFile(filePath, 'utf8'); }
  catch (error) { throw Error(`${label} cannot be read (${filePath}): ${error.message}`); }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Root must be a JSON object');
    return parsed;
  } catch (error) { throw Error(`${label} is not valid JSON (${filePath}): ${error.message}`); }
}

async function checkCertFile(certPath, label) {
  const pem = await fs.readFile(certPath, 'utf8').catch(error => {
    throw Error(`${label} certificate file unreadable (${certPath}): ${error.message}`);
  });
  return checkCertPem(pem, `${label} (${certPath})`);
}

function checkCertPem(pem, label) {
  try {
    const cert = new X509Certificate(pem);
    return { subject: cert.subject, fingerprint256: cert.fingerprint256, validTo: cert.validTo };
  } catch (error) {
    throw Error(`${label} is not a valid X.509 PEM certificate: ${error.message}`);
  }
}

async function checkPrivateKeyFile(keyPath, label) {
  const pem = await fs.readFile(keyPath, 'utf8').catch(error => {
    throw Error(`${label} private key unreadable (${keyPath}): ${error.message}`);
  });
  try { createPrivateKey(pem); }
  catch (error) { throw Error(`${label} is not a valid private key (${keyPath}): ${error.message}`); }
}

export async function checkConfig(configPath) {
  if (!configPath) throw Error('Configuration file path is required');
  const resolved = path.resolve(configPath);
  const config = await readJson(resolved, 'Configuration');

  if (config.role === 'source') {
    for (const key of ['macName', 'target', 'nativeIPC', 'routeSocket', 'peerPort', 'peerCertificate', 'peerToken']) {
      if (!config[key]) throw Error(`Source configuration missing required field: ${key}`);
    }
    if (!validPort(config.peerPort)) throw Error('Source peerPort must be an integer in 1..65535');
    if (!validToken(config.peerToken)) throw Error('Source peerToken must be at least 32 characters and not a placeholder');
    const peerCert = await checkCertFile(config.peerCertificate, 'Source peerCertificate');
    const details = { kind: 'gesture-source', mode: config.realFiles === true ? 'verified-file-transfer' : 'pre-positioned-fixture',
      macName: config.macName, target: config.target, peerPort: config.peerPort, peerFingerprint256: peerCert.fingerprint256 };
    if (config.realFiles === true) {
      if (!config.uploadReceiver || !config.uploadPeer) throw Error('Real-file source configuration requires uploadReceiver and uploadPeer');
      details.uploadReceiver = await checkConfig(config.uploadReceiver);
      details.uploadPeer = await checkConfig(config.uploadPeer);
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
    const cert = await checkCertFile(config.certificate, 'Destination');
    await checkPrivateKeyFile(config.key, 'Destination');
    const details = { kind: 'gesture-destination', mode: config.realFiles === true ? 'verified-file-transfer' : 'pre-positioned-fixture',
      bind: config.bind || '127.0.0.1', port: config.port, fingerprint256: cert.fingerprint256 };
    if (config.realFiles === true) {
      if (!config.uploadReceiver || !config.uploadPeer) throw Error('Real-file destination configuration requires uploadReceiver and uploadPeer');
      details.uploadReceiver = await checkConfig(config.uploadReceiver);
      details.uploadPeer = await checkConfig(config.uploadPeer);
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
    const cert = checkCertPem(config.certificate, 'Peer certificate');
    return { kind: 'transport-peer', baseURL: config.baseURL, fingerprint256: cert.fingerprint256 };
  }

  if (config.inbox && config.certificate && config.key) {
    if (!validPort(config.port)) throw Error('Receiver port must be an integer in 1..65535');
    if (!validToken(config.token)) throw Error('Receiver token must be at least 32 characters and not a placeholder');
    if (config.maxBytes !== undefined && (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1 || config.maxBytes > DRAG_BYTES)) {
      throw Error(`Gesture receiver maxBytes must be between 1 and ${DRAG_BYTES}`);
    }
    const cert = await checkCertFile(config.certificate, 'Receiver');
    await checkPrivateKeyFile(config.key, 'Receiver');
    return { kind: 'transport-receiver', bind: config.bind || '127.0.0.1', port: config.port, fingerprint256: cert.fingerprint256 };
  }

  throw Error('Unrecognized configuration schema: expected source, destination, transport-receiver or transport-peer');
}
