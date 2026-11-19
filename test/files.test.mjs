import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collect, safeRelative, validateManifest } from '../src/files.mjs';

test('collect maps portable names, deduplicates each level and retains real sources', { skip: process.platform !== 'linux' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edgebridge-names-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = ['Q3 report?.pptx', 'a:b.txt', 'Icon\r', 'con.txt', 'PRN', 'a?.txt', 'a？.txt', 'e\u0301.txt', 'trail. ', 'x<>"\\|*.txt'];
  for (const name of names) await fs.writeFile(path.join(root, name), name);
  const selection = await collect(names.map(name => path.join(root, name)), { prehash: false });
  assert.deepEqual(selection.entries.map(e => e.name), ['Q3 report？.pptx', 'a：b.txt', 'Icon_', 'con_.txt', 'PRN_',
    'a？.txt', 'a？ (2).txt', 'é.txt', 'trail．　', 'x＜＞＂＼｜＊.txt']);
  for (const [index, source] of selection.sources) {
    assert.equal(source, path.join(root, names[index]));
    assert.equal('sha256' in selection.entries[index], false);
    safeRelative(selection.entries[index].name);
  }
  await fs.mkdir(path.join(root, 'a'));
  await fs.mkdir(path.join(root, 'b'));
  for (const parent of ['a', 'b']) {
    await fs.writeFile(path.join(root, parent, 'report.pptx'), parent);
    await fs.mkdir(path.join(root, parent, 'Folder'));
    await fs.writeFile(path.join(root, parent, 'Folder', 'A.txt'), 'a');
    await fs.writeFile(path.join(root, parent, 'Folder', 'a.txt'), 'b');
  }
  const duplicates = await collect(['a/report.pptx', 'b/report.pptx', 'a/Folder', 'b/Folder', 'a/report.pptx'].map(name => path.join(root, name)));
  assert.deepEqual(duplicates.entries.map(e => e.name), ['report.pptx', 'report (2).pptx', 'Folder', 'Folder/A.txt', 'Folder/a (2).txt',
    'Folder (2)', 'Folder (2)/A.txt', 'Folder (2)/a (2).txt', 'report (3).pptx']);
  await assert.rejects(collect([]), /Entry limit/u);
});

test('manifest permits omitted hashes but rejects malformed hashes and names identify the offender', () => {
  const entry = { name: 'empty', kind: 'file', size: 0 };
  assert.deepEqual(validateManifest([entry]), [entry]);
  for (const sha256 of [null, undefined, '', 'z'.repeat(64), 123]) assert.throws(() => validateManifest([{ ...entry, sha256 }]), /metadata/u);
  for (const name of ['bad?', 'a.', 'CON.txt', 'a'.repeat(201)]) assert.throws(() => safeRelative(name), error => error.message.includes(name));
});
