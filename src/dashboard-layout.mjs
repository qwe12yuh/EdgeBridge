export const layouts = Object.freeze(['mac-left', 'mac-right']);

export function deskflowLayout(text, mac, windows) {
  if (![mac, windows].every(name => typeof name === 'string' && /^[a-z0-9_.-]+$/iu.test(name)) || mac === windows) {
    throw Error('无法确认 Deskflow 的两台设备名称。');
  }
  const lines = text.split('\n');
  const entries = [];
  let inLinks = false, screen;
  for (const [index, line] of lines.entries()) {
    if (/^\s*section:\s*links\s*$/u.test(line)) { inLinks = true; screen = undefined; continue; }
    if (/^\s*end\s*$/u.test(line)) { inLinks = false; continue; }
    if (!inLinks) continue;
    const heading = line.match(/^\s*([\w.-]+):\s*$/u);
    if (heading) { screen = heading[1]; continue; }
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const link = line.match(/^(\s*)(left|right)(\s*=\s*)([\w.-]+)(\s*(?:#.*)?)$/u);
    if (!link || ![mac, windows].includes(screen)) throw Error('暂只支持一对相邻的横向屏幕。');
    entries.push({ index, screen, link });
  }
  const fromMac = entries.find(entry => entry.screen === mac && entry.link[4] === windows);
  const fromWindows = entries.find(entry => entry.screen === windows && entry.link[4] === mac);
  if (entries.length !== 2 || !fromMac || !fromWindows || fromMac.link[2] === fromWindows.link[2]) {
    throw Error('Deskflow 配置必须包含一对相反方向的链接。');
  }
  const layout = fromMac.link[2] === 'right' ? 'mac-left' : 'mac-right';
  return {
    layout,
    render(next) {
      if (!layouts.includes(next)) throw Error('无效的屏幕布局。');
      if (next === layout) return text;
      const updated = [...lines];
      for (const { index, link } of entries) {
        updated[index] = link[1] + (link[2] === 'left' ? 'right' : 'left') + link[3] + link[4] + link[5];
      }
      return updated.join('\n');
    },
  };
}
