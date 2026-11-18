const mode = document.querySelector('#mode');
const description = document.querySelector('#description');
const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const notice = document.querySelector('#notice');
const apply = document.querySelector('#apply');
const devices = document.querySelector('#devices');
const layoutHint = document.querySelector('#layout-hint');
const choices = Array.from(document.querySelectorAll('input[name="layout"]'));
let busy = false, refreshing = false, version = 0;
let appliedLayout, available = false, upgrade = false, currentMode;

const states = {
  running: ['运行中', '键鼠共享和跨屏文件拖放均已连接。', 'good'],
  stopped: ['已停止', '启动后即可在两块屏幕之间使用同一套键鼠。', ''],
  partial: ['未完全连通', '部分组件已启动。可以重试，或停止后重新启动。', 'warn'],
  unknown: ['等待 Windows', '暂无法确认 Windows 状态，请检查电脑与网线连接。', 'warn'],
  starting: ['正在启动', '正在连接 Mac 和 Windows，请稍候。', ''],
  stopping: ['正在停止', '正在关闭双机组件，请稍候。', ''],
  switching: ['正在切换', '正在应用新的屏幕布局并恢复连接。', ''],
};
function selection() { return choices.find(choice => choice.checked)?.value ?? 'mac-left'; }
function showLayout() {
  const next = selection();
  const runningAction = busy || ['starting', 'stopping', 'switching'].includes(currentMode);
  devices.dataset.layout = next;
  document.querySelector('#layout-view').textContent = appliedLayout && next !== appliedLayout ? '布局预览' : '当前布局';
  document.querySelector('#mac-position').textContent = next === 'mac-left' ? '左侧' : '右侧';
  document.querySelector('#win-position').textContent = next === 'mac-left' ? '右侧' : '左侧';
  for (const choice of choices) choice.disabled = runningAction;
  apply.disabled = runningAction || !available || next === appliedLayout || !['running', 'stopped'].includes(currentMode);
  if (runningAction) layoutHint.textContent = '操作进行中，请稍候。';
  else if (!available) layoutHint.textContent = '目前可以预览。应用新方向需要启用支持双向布局的路由和原生组件。';
  else if (upgrade && next !== appliedLayout) layoutHint.textContent = '首次应用可能需要为新版 Mac 组件授权；授权前会保持当前协同。';
  else if (next !== appliedLayout) layoutHint.textContent = currentMode === 'running'
    ? '应用会短暂重连。请松开鼠标并把指针留在 Mac 屏上。'
    : '应用后，下次启动将使用此布局。';
  else layoutHint.textContent = next === 'mac-left' ? '当前布局：Mac 左 · Windows 右。' : '当前布局：Windows 左 · Mac 右。';
}
function indicator(id, value, on, off) {
  const item = document.getElementById(id);
  item.textContent = value ? on : value === false ? off : '暂未确认';
  item.dataset.tone = value ? 'good' : '';
}
function render(status) {
  const [label, context, tone] = states[status.mode] ?? states.unknown;
  currentMode = status.mode;
  mode.textContent = label;
  mode.dataset.tone = tone;
  description.textContent = context;
  if (!['starting', 'stopping', 'switching'].includes(status.mode)) {
    indicator('mac', status.mac, '已就绪', '未就绪');
    indicator('windows', status.windows, '已就绪', '未就绪');
    indicator('link', status.keyboard, '键鼠已连通', '键鼠未连通');
    if (status.layout) {
      if (!appliedLayout || selection() === appliedLayout) {
        for (const choice of choices) choice.checked = choice.value === status.layout;
      }
      appliedLayout = status.layout;
      available = status.layoutAvailable === true;
      upgrade = status.layoutUpgrade === true;
    }
  }
  start.disabled = busy || !['stopped', 'partial'].includes(status.mode);
  stop.disabled = busy || !['running', 'partial'].includes(status.mode);
  showLayout();
}
async function request(path, method = 'GET') {
  const response = await fetch(`/api/${path}`, { method, headers: method === 'POST' ? { 'x-edgebridge-control': '1' } : {} });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}
async function refresh() {
  if (busy || refreshing) return;
  refreshing = true;
  const stamp = ++version;
  try {
    const status = await request('status');
    if (!busy && version === stamp) render(status);
  } catch {
    if (!busy && version === stamp) render({ mode: 'unknown' });
  } finally { refreshing = false; }
}
async function control(action) {
  if (busy) return;
  busy = true;
  ++version;
  notice.hidden = true;
  render({ mode: action.startsWith('layout/') ? 'switching' : action === 'start' ? 'starting' : 'stopping' });
  let result;
  try { result = await request(action, 'POST'); }
  catch (error) {
    notice.textContent = error.message;
    notice.hidden = false;
  } finally {
    busy = false;
    if (result) render(result);
    await refresh();
  }
}
start.addEventListener('click', () => control('start'));
stop.addEventListener('click', () => control('stop'));
apply.addEventListener('click', () => control(`layout/${selection()}`));
for (const choice of choices) choice.addEventListener('change', showLayout);
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
