import fs from 'node:fs/promises';
import path from 'node:path';

export async function peerAppKit(directory, onEvent, onFailure) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw Error('Experimental AppKit IPC requires a private directory owned by the current user');
  }
  const events = path.join(directory, 'events.jsonl');
  const commands = path.join(directory, 'commands.jsonl');
  const heartbeat = path.join(directory, 'heartbeat');
  let offset = (await fs.stat(events).catch(() => null))?.size ?? 0;
  let remainder = Buffer.alloc(0), reading = false, beating = false, stopped = false;
  let writes = Promise.resolve();
  const send = message => {
    let command = message;
    if (message.command === 'source-commit') command = { ...message, command: 'commit' };
    else if (message.command === 'source-reset') command = { ...message, command: 'reset' };
    else if (['candidate', 'candidate-ended'].includes(message.command)) command = { ...message, time: Date.now() };
    else if (message.command !== 'shutdown') return Promise.reject(Error('AppKit peer only supports the source experiment'));
    writes = writes.catch(() => {}).then(() => fs.appendFile(commands, JSON.stringify(command) + '\n', { mode: 0o600 }));
    return writes;
  };
  const poll = setInterval(async () => {
    if (reading || stopped) return;
    reading = true;
    let file;
    try {
      file = await fs.open(events, 'r');
      if ((await file.stat()).size < offset) { offset = 0; remainder = Buffer.alloc(0); }
      const bytes = Buffer.alloc(65536);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      offset += bytesRead;
      remainder = Buffer.concat([remainder, bytes.subarray(0, bytesRead)]);
      if (remainder.length > 131072) throw Error('AppKit peer frame too large');
      while (!stopped && remainder.includes(10)) {
        const newline = remainder.indexOf(10);
        const event = JSON.parse(remainder.toString('utf8', 0, newline));
        remainder = remainder.subarray(newline + 1);
        onEvent(event);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') onFailure(error);
    } finally { await file?.close(); reading = false; }
  }, 20);
  const tick = async () => {
    if (beating || stopped) return;
    beating = true;
    const temporary = heartbeat + '-' + process.pid;
    try {
      await fs.writeFile(temporary, String(Date.now()), { mode: 0o600 });
      await fs.rename(temporary, heartbeat);
    } catch (error) { onFailure(error); }
    finally { beating = false; }
  };
  const beat = setInterval(tick, 500);
  await tick();
  return { send, close() { stopped = true; clearInterval(poll); clearInterval(beat); } };
}
