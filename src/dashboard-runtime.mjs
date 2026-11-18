import { execFile, spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { access, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, win32 } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { deskflowLayout, layouts } from './dashboard-layout.mjs';

const exec = promisify(execFile);
const forwards = ['-L127.0.0.1:24813:127.0.0.1:24813', '-L127.0.0.1:24815:127.0.0.1:24815', '-R127.0.0.1:24814:127.0.0.1:24814'];
const sshOptions = ['-T', '-n', '-oBatchMode=yes', '-oConnectTimeout=4', '-oStrictHostKeyChecking=yes'];
const run = (file, args) => exec(file, args, { timeout: 10000, maxBuffer: 524288 });

async function until(check, message, timeout = 9000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await sleep(250);
  } while (Date.now() < deadline);
  throw Error(message);
}

export function createRuntime(config) {
  const pathKeys = ['stateDirectory', 'routerApp', 'gestureApp', 'coordinatorScript'];
  if (!pathKeys.every(key => typeof config[key] === 'string' && isAbsolute(config[key]))) {
    throw Error('控制面板配置中的目录与程序路径必须是绝对路径。');
  }
  if (!['windowsCoordinatorPath', 'windowsHelperPath'].every(key =>
      typeof config[key] === 'string' && win32.isAbsolute(config[key]))) {
    throw Error('请配置 Windows 协调器和辅助程序的绝对路径。');
  }
  if (typeof config.windowsHost !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/i.test(config.windowsHost)) {
    throw Error('请配置已信任的 Windows SSH 主机名。');
  }
  const runtime = config.stateDirectory;
  const taskNames = { deskflow: 'Deskflow-KeyboardMouse', edgebridge: config.windowsTask ?? 'EdgeBridge-GestureLab-Test' };
  if (!/^[a-z0-9][a-z0-9.-]*$/iu.test(taskNames.edgebridge)) throw Error('Windows 任务名称无效。');
  const sourceConfig = config.sourceConfig ?? join(runtime, 'source.local.json');
  const core = config.coreBinary ?? join(runtime, 'bin', 'deskflow-core');
  const coreSettings = config.coreSettings ?? join(runtime, 'core-settings.ini');
  const layoutPath = config.layoutServerConfig;
  if ([core, coreSettings, sourceConfig, ...(layoutPath ? [layoutPath] : [])].some(value => typeof value !== 'string' || !isAbsolute(value))) {
    throw Error('请使用绝对路径配置 Deskflow 路由。');
  }
  const routerBinary = join(config.routerApp, 'Contents', 'MacOS', 'EdgeBridgeRouterLab');
  const gestureBinary = join(config.gestureApp, 'Contents', 'MacOS', 'EdgeBridgeGestureLab');
  const node = isAbsolute(process.argv0) ? process.argv0 : process.execPath;
  const sourceArgs = [config.coordinatorScript, sourceConfig];
  const coordinators = new Set([node, process.execPath].map(binary => [binary, ...sourceArgs].join(' ')));
  const signatures = {
    router: routerBinary,
    core: `${core} server --settings ${coreSettings}`,
    helper: gestureBinary,
  };
  const ssh = command => run('/usr/bin/ssh', [...sshOptions, config.windowsHost, command]);
  const powershell = command => ssh('powershell.exe -NoProfile -NonInteractive -EncodedCommand ' +
    Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${command}`, 'utf16le').toString('base64'));
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const winProcessQuery = `
    $coordinatorPattern = '(^|\\s)"?' + [regex]::Escape(${literal(config.windowsCoordinatorPath)}) + '"?(?=\\s|$)'
    $coordinators = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.SessionId -gt 0 -and $_.CommandLine -match $coordinatorPattern })
  `;
  const showApp = app => run('/usr/bin/open', ['-g', app]);
  const taskChange = async (action, task) => {
    await powershell(`${action}-ScheduledTask -TaskName ${taskNames[task]}`);
  };
  async function topology() {
    if (!layoutPath) return null;
    const [{ macName, target }, text, ini] = await Promise.all([
      readFile(sourceConfig, 'utf8').then(JSON.parse), readFile(layoutPath, 'utf8'), readFile(coreSettings, 'utf8'),
    ]);
    const section = ini.split(/\r?\n\[/u).find(value => value.startsWith('server]'));
    if (!section || !section.split(/\r?\n/u).includes('externalConfig=true') ||
        !section.split(/\r?\n/u).includes(`externalConfigFile=${layoutPath}`)) {
      throw Error('Deskflow 必须使用已配置的独立屏幕布局文件。');
    }
    return { ...deskflowLayout(text, macName, target), text };
  }

  async function writeTopology(text) {
    const temp = `${layoutPath}.${randomUUID()}.tmp`;
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 });
    await rename(temp, layoutPath);
  }

  async function processes() {
    const { stdout } = await run('/bin/ps', ['-axww', '-o', 'pid=,uid=,args=']);
    const result = {};
    for (const line of stdout.trimEnd().split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match || Number(match[2]) !== process.getuid()) continue;
      const [, pid, , args] = match;
      const task = coordinators.has(args) ? 'mac' : Object.keys(signatures).find(key => signatures[key] === args);
      if (task) result[task] = Number(pid);
      const [tool, ...flags] = args.split(' ');
      if (['ssh', '/usr/bin/ssh'].includes(tool) && flags.at(-1) === config.windowsHost &&
          flags.includes('-N') && forwards.every(flag => flags.includes(flag)) &&
          flags.filter(flag => /^-[LRD]/.test(flag)).length === forwards.length) result.tunnel = Number(pid);
    }
    return result;
  }

  async function windowsStatus() {
    try {
      const { stdout } = await powershell(`
        ${winProcessQuery}
        $keyboard = Get-ScheduledTask -TaskName ${taskNames.deskflow}
        $endpoint = Get-ScheduledTask -TaskName ${taskNames.edgebridge}
        $listener = @(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 24813 -ErrorAction SilentlyContinue)
        @{
          keyboard = ($keyboard.State -eq 'Running')
          endpoint = [bool]($listener | Where-Object { $coordinators.ProcessId -contains $_.OwningProcess })
          endpointPresent = ($endpoint.State -eq 'Running' -or $coordinators.Count -gt 0)
        } | ConvertTo-Json -Compress
      `);
      return JSON.parse(stdout.trim());
    } catch { return null; }
  }

  async function stopWindowsEndpoint() {
    await powershell(`
      if ((Get-ScheduledTask -TaskName ${taskNames.edgebridge}).State -eq 'Running') {
        Stop-ScheduledTask -TaskName ${taskNames.edgebridge}
      }
      ${winProcessQuery}
      $helpers = Get-CimInstance Win32_Process -Filter ${literal(`Name='${win32.basename(config.windowsHelperPath).replaceAll("'", "''")}'`)} | Where-Object { $_.SessionId -gt 0 -and $_.ExecutablePath -eq ${literal(config.windowsHelperPath)} }
      @($coordinators) + @($helpers | Where-Object { $_ }) | ForEach-Object {
        if (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue) {
          Stop-Process -Id $_.ProcessId
        }
      }
    `);
  }

  async function hasSocket(state, established) {
    const args = state ? ['-a', '-p', String(state)] : [];
    try {
      const { stdout } = await run('/usr/sbin/lsof', [...args, '-nP', '-iTCP:24800', `-sTCP:${established ? 'ESTABLISHED' : 'LISTEN'}`]);
      return stdout.length > 0;
    } catch (error) {
      if (error.code === 1 && !error.stderr) return false;
      throw error;
    }
  }

  async function macReady(local) {
    if (!local.mac || !local.helper) return false;
    const heartbeat = await stat(join(runtime, 'native', 'heartbeat')).catch(() => null);
    return Boolean(heartbeat && Date.now() - heartbeat.mtimeMs < 2500);
  }

  async function status() {
    const [local, windows, layout] = await Promise.all([processes(), windowsStatus(), topology()]);
    const [mac, keyboard] = await Promise.all([macReady(local), local.core ? hasSocket(local.core, true) : false]);
    const active = Boolean(mac && local.core && local.tunnel && windows?.endpoint && keyboard);
    const partial = Boolean(Object.keys(local).length || windows?.endpointPresent);
    return {
      mode: active ? 'running' : partial ? 'partial' : windows ? 'stopped' : 'unknown',
      mac, keyboard, windows: windows?.endpoint ?? null, tunnel: Boolean(local.tunnel),
      layout: layout?.layout ?? 'mac-left', layoutAvailable: Boolean(layout),
    };
  }

  async function stopProcess(task, pid) {
    if (!pid || (await processes())[task] !== pid) return;
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await until(async () => (await processes())[task] !== pid, `Mac 组件 ${task} 未正常退出。`);
  }

  async function stop() {
    const local = await processes();
    const windows = await windowsStatus();
    const errors = [];
    const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error.message); } };
    for (const task of ['mac', 'helper', 'core', 'router', 'tunnel']) {
      await attempt(() => stopProcess(task, local[task]));
    }
    if (!windows) {
      errors.push('Windows 无法连接，未能确认或停止 Windows 组件。');
    }
    if (windows?.endpointPresent) await attempt(async () => {
      await stopWindowsEndpoint();
      await until(async () => (await windowsStatus())?.endpointPresent === false, 'Windows 文件拖放组件仍未停止。');
    });
    if (windows?.keyboard && (local.core || windows.endpointPresent) && !await hasSocket(null, false)) {
      await attempt(async () => {
        await taskChange('Stop', 'deskflow');
        await until(async () => (await windowsStatus())?.keyboard === false, 'Windows 键鼠客户端仍未停止。');
      });
    }
    if (errors.length) throw Error(errors.join(' '));
  }

  async function start() {
    const initial = await processes();
    const windows = await windowsStatus();
    const layout = await topology();
    if (!windows) throw Error('连不上 Windows，或找不到已配置的两项任务。');
    if (initial.core && initial.tunnel && windows.endpoint && await macReady(initial) && await hasSocket(initial.core, true)) return;
    if (!initial.core && await hasSocket(null, false)) {
      throw Error('Deskflow 的 24800 端口已占用。请先停止原版 Mac Deskflow 服务，再启动 EdgeBridge。');
    }
    if (!(await Promise.all([core, coreSettings, routerBinary, gestureBinary, sourceConfig, config.coordinatorScript].map(file => access(file).then(() => true, () => false)))).every(Boolean)) {
      throw Error('Mac 的 EdgeBridge 构建产物或配对配置不完整。');
    }
    const startedTasks = [];
    try {
      if (!initial.tunnel) await run('/usr/bin/ssh', ['-f', ...sshOptions, '-N', '-oExitOnForwardFailure=yes', '-oServerAliveInterval=10', ...forwards, config.windowsHost]);
      if (!initial.core) {
        await showApp(config.routerApp);
        await until(async () => {
          if (!(await processes()).core) return false;
          return await stat(join(runtime, 'route.sock')).then(socket => socket.isSocket(), () => false);
        }, 'Mac 路由器未就绪。请检查 EdgeBridge Router Lab 的辅助功能授权。');
      }
      for (const [task, started] of [['deskflow', windows.keyboard], ['edgebridge', windows.endpointPresent]]) {
        if (!started) {
          await taskChange('Start', task);
          startedTasks.push(task);
        }
      }
      if (!initial.mac) {
        await until(async () => {
          return (await windowsStatus())?.endpoint === true;
        }, 'Windows 文件拖放服务未开始监听。');
        const log = openSync(join(runtime, 'coordinator.log'), 'a', 0o600);
        try {
          const env = layout ? { ...process.env, EDGEBRIDGE_MAC_EDGE: layout.layout === 'mac-left' ? 'right' : 'left' } : process.env;
          const child = spawn(node, sourceArgs, { detached: true, stdio: ['ignore', log, log], env });
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          child.unref();
        } finally { closeSync(log); }
        await until(async () => {
          const state = await processes();
          return state.mac && await stat(join(runtime, 'native', 'heartbeat')).then(heartbeat => Date.now() - heartbeat.mtimeMs < 2500, () => false);
        }, 'Mac 协调器未就绪。请检查配对和隧道。');
      }
      if (!initial.helper) await showApp(config.gestureApp);
      await until(async () => (await status()).mode === 'running',
        '双机未完全连通。请检查 Windows 登录桌面与 Mac 手势程序的辅助功能权限。', 14000);
    } catch (error) {
      const now = await processes();
      const cleanup = [];
      for (const key of ['mac', 'helper', 'core', 'router', 'tunnel']) {
        if (!initial[key]) await stopProcess(key, now[key]).catch(() => cleanup.push(key));
      }
      for (const task of startedTasks.reverse()) {
        await (task === 'edgebridge' ? stopWindowsEndpoint() : taskChange('Stop', task)).catch(() => cleanup.push(task));
      }
      throw Error(error.message + (cleanup.length ? ` 部分组件未能自动清理：${cleanup.join('、')}。` : ''));
    }
  }

  async function assertIdle() {
      const file = await open(join(runtime, 'coordinator.log'), 'r');
      let tail;
      try {
        const { size } = await file.stat();
        const bytes = Buffer.alloc(Math.min(size, 16384));
        await file.read(bytes, 0, bytes.length, size - bytes.length);
        tail = bytes.toString('utf8');
      } finally { await file.close(); }
      const last = tail.trimEnd().split('\n').at(-1);
      let idle;
      try { idle = JSON.parse(last); } catch {}
      const age = Date.now() - Date.parse(idle?.observedAt);
      if (idle?.event !== 'status' || idle.held !== false || !idle.onPrimary ||
          !Number.isFinite(age) || age < 0 || age > 4200) {
        throw Error('请结束正在进行的拖放，把指针移回 Mac 后重试。');
      }
  }

  async function setLayout(next) {
    if (!layouts.includes(next)) throw Error('无效的屏幕布局。');
    const original = await topology();
    if (!original) throw Error('此部署还未启用可切换布局的路由和原生组件。');
    if (original.layout === next) return;
    const current = await status();
    if (!['running', 'stopped'].includes(current.mode)) throw Error('请先恢复或停止双机服务，再切换布局。');
    const running = current.mode === 'running';
    if (running) await assertIdle();
    let saved = false;
    try {
      if (running) await stop();
      await writeTopology(original.render(next));
      saved = true;
      if (running) await start();
    } catch (error) {
      try {
        if (saved) await writeTopology(original.text);
        if (running) await start();
      } catch { throw Error('布局未能应用，原布局也未恢复连接。请在控制台停止后重新启动。'); }
      throw Error(`新布局未应用。${error.message}`);
    }
  }

  async function checkAccessibility() {
    const programs = [[config.routerApp, 'EdgeBridge Layout Router'], [config.gestureApp, 'EdgeBridge Layout Gesture']];
    const pending = [];
    for (const [app, name] of programs) {
      const output = join(runtime, `.access-check-${randomUUID()}.log`);
      await writeFile(output, '', { flag: 'wx', mode: 0o600 });
      try {
        await run('/usr/bin/open', ['-g', '-n', '-W', '--stdout', output, '-a', app, '--args', '--request-accessibility']);
        if (!(await readFile(output, 'utf8')).includes('Accessibility: authorized')) pending.push(name);
      } finally { await unlink(output).catch(() => {}); }
    }
    if (pending.length) {
      throw Error(`请在 Mac「系统设置 → 隐私与安全性 → 辅助功能」开启 ${pending.join('、')} 后，再点应用布局。当前协同保持运行。`);
    }
  }

  return { status, start, stop, setLayout, assertIdle, checkAccessibility };
}

export async function createManagedRuntime(config) {
  const base = createRuntime(config);
  if (!config.layoutProfile) return base;
  if (!isAbsolute(config.layoutProfile)) throw Error('布局升级配置必须使用绝对路径。');
  const upgraded = createRuntime({ ...config, ...JSON.parse(await readFile(config.layoutProfile, 'utf8')) });
  const marker = join(config.stateDirectory, 'dashboard-layout-enabled');
  let active = await access(marker).then(() => upgraded, error => {
    if (error.code === 'ENOENT') return base;
    throw error;
  });
  return {
    async status() {
      return { ...await active.status(), layoutAvailable: true, layoutUpgrade: active === base };
    },
    async start() { await active.start(); },
    async stop() { await active.stop(); },
    async setLayout(next) {
      if (active === upgraded) return upgraded.setLayout(next);
      const { mode } = await base.status();
      if (!['running', 'stopped'].includes(mode)) throw Error('请先恢复或停止双机服务，再切换布局。');
      if (mode === 'running') await base.assertIdle();
      await upgraded.checkAccessibility();
      if (mode === 'running') await base.assertIdle();
      try {
        if (mode === 'running') await base.stop();
        await upgraded.setLayout(next);
        if (mode === 'running') await upgraded.start();
        await writeFile(marker, 'enabled\n', { flag: 'wx', mode: 0o600 });
        active = upgraded;
      } catch (error) {
        try {
          await upgraded.stop();
          if (mode === 'running') await base.start();
        } catch { throw Error('新布局未应用，原协同未能自动恢复。请点击启动协同。'); }
        throw Error(`新布局未应用。${error.message}`);
      }
    },
  };
}
