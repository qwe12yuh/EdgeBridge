import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createManagedRuntime } from './dashboard-runtime.mjs';
import { layouts } from './dashboard-layout.mjs';

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/dashboard.css': ['dashboard.css', 'text/css; charset=utf-8'],
  '/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
};

export function createDashboard(runtime) {
  let pending = null, queuedStatus = null;
  return createServer({ requestTimeout: 10000 }, async (req, res) => {
    const host = `127.0.0.1:${req.socket.localPort}`;
    const reply = (code, data, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      res.end(typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data);
    };
    if (req.headers.host !== host) return reply(403, { error: '只接受本机地址。' });
    try {
      if (req.method === 'GET' && Object.hasOwn(assets, req.url)) {
        const [file, type] = assets[req.url];
        return reply(200, await readFile(new URL(`../dashboard/${file}`, import.meta.url)), type);
      }
      if (req.method === 'GET' && req.url === '/api/status') {
        if (pending) return reply(200, { mode: pending });
        queuedStatus ||= runtime.status().finally(() => { queuedStatus = null; });
        return reply(200, await queuedStatus);
      }
      const layout = layouts.find(value => req.url === `/api/layout/${value}`);
      if (req.method === 'POST' && (layout || ['/api/start', '/api/stop'].includes(req.url))) {
        if (req.headers.origin !== `http://${host}` || req.headers['x-edgebridge-control'] !== '1' ||
            (req.headers['content-length'] ?? '0') !== '0' || req.headers['transfer-encoding']) {
          return reply(403, { error: '只接受控制页发出的请求。' });
        }
        if (pending) return reply(409, { error: '已有操作正在执行。' });
        const action = req.url === '/api/start' ? 'start' : 'stop';
        pending = layout ? 'switching' : action === 'start' ? 'starting' : 'stopping';
        try {
          if (layout) await runtime.setLayout(layout);
          else await runtime[action]();
          return reply(200, await runtime.status());
        } finally { pending = null; }
      }
      return reply(404, { error: '未找到页面。' });
    } catch (error) {
      return reply(500, { error: error.message });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? join(homedir(), '.edgebridge-lab', 'dashboard.local.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  const port = config.port ?? 24816;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('控制面板端口无效。');
  createDashboard(await createManagedRuntime(config)).listen(port, '127.0.0.1', () => {
    console.log(`EdgeBridge 控制台：http://127.0.0.1:${port}/`);
  });
}
