import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'parse5';
import electron from 'electron';
import { source, css, edits } from './acceptance-fixture.ts';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const results = join(root, 'test-results');
const childEntry = join(root, 'out/product-acceptance-child/index.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
// Independent full-source oracle, never derived from a production range/candidate.
const replacements = [
  ['年度 &#65; 报告 😀', '年度 B 报告 🧪'], ['2025-01-01', '2026-09-10'],
  ['一 &amp; 二', '核对 &lt;&amp;&gt;'], ['1000.00', '1234.56'], ['原摘要', '服务费用已复核'],
];
function expected(count = 5, original = source) {
  let value = original;
  for (const [before, after] of replacements.slice(0, count)) {
    assert.equal(value.split(before).length, 2);
    value = value.replace(before, after);
  }
  return Buffer.from(value);
}
async function fixture(directory = false) {
  const base = await mkdtemp(join(results, 'acceptance-'));
  const project = join(base, 'project'); await mkdir(project);
  const entryRoot = directory ? join(project, 'pages') : project;
  const cssRoot = directory ? join(project, 'assets') : project;
  if (directory) { await mkdir(entryRoot); await mkdir(cssRoot); }
  const documentSource = directory ? source.replace('href="keep.css"', 'href="../assets/keep.css"') : source;
  const entry = join(entryRoot, '报告.html'), cssPath = join(cssRoot, 'keep.css');
  await writeFile(entry, documentSource);
  await writeFile(join(entryRoot, 'wrong.html'), documentSource);
  await writeFile(cssPath, css);
  if (directory) await writeFile(join(base, 'outside.html'), documentSource);
  return { base, project, profile: join(base, 'profile'), entry, cssPath, directory, source: documentSource };
}
function launch(t, mode, value, sessionId = '') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [childEntry, mode, value.profile, value.project, sessionId, value.directory ? 'directory' : 'file'], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const receipts = []; const listeners = new Set();
  let ended = null; let output = ''; let buffer = ''; let failure = null;
  const finish = (code, signal) => { ended = { code, signal }; for (const notify of listeners) notify(); };
  child.on('error', error => { failure = error; finish(null, null); });
  child.on('close', finish);
  const append = chunk => { output = (output + chunk).slice(-262144); };
  child.stderr.on('data', append);
  child.stdout.on('data', chunk => {
    append(chunk); buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line.startsWith('HAE_ACCEPTANCE:')) continue;
      const receipt = JSON.parse(line.slice('HAE_ACCEPTANCE:'.length)); receipts.push(receipt);
      if (receipt.event === 'failed') failure = new Error(receipt.error + '\n' + (receipt.stack ?? '') + '\n' + JSON.stringify(receipt.state));
      for (const notify of listeners) notify();
    }
  });
  function wait(check, label, timeout = 45000) {
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { listeners.delete(inspect); reject(new Error(mode + ': timeout ' + label + '\n' + output.slice(-3500))); }, timeout);
      const inspect = () => {
        const answer = check();
        if (!failure && answer === undefined && !ended) return;
        clearTimeout(timer); listeners.delete(inspect);
        if (failure) reject(failure);
        else if (answer !== undefined) accept(answer);
        else reject(new Error(mode + ': exited before ' + label + ' ' + JSON.stringify(ended) + '\n' + output.slice(-3500)));
      };
      listeners.add(inspect); inspect();
    });
  }
  t.after(async () => {
    if (!ended) {
      child.kill('SIGKILL');
      await new Promise(accept => { if (ended) accept(); else child.once('close', accept); });
    }
    await writeFile(join(value.base, mode + '.log'), output);
  });
  return {
    child, receipts,
    receipt: name => wait(() => receipts.find(value => value.event === name), name),
    exited: () => wait(() => ended ?? undefined, 'clean process exit'),
    get output() { return output; },
  };
}
function nodeBy(root, check) {
  if (check(root)) return root;
  for (const child of root.childNodes ?? []) { const match = nodeBy(child, check); if (match) return match; }
}
const textOf = value => value.nodeName === '#text' ? value.value : (value.childNodes ?? []).map(textOf).join('');
async function browserReopen(value, expectedTexts) {
  const candidates = [
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  let edge;
  for (const candidate of candidates) { try { await access(candidate); edge = candidate; break; } catch {} }
  assert.ok(edge, 'An installed independent Edge browser is required for this Windows acceptance test.');
  const browserProfile = await mkdtemp(join(value.base, 'edge-'));
  // Edge's Windows compatibility relaunch can lose inherited stdout/stderr.
  // Use Playwright's upstream launch workaround; keep the browser sandbox on.
  const { stdout } = await execute(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--edge-skip-compat-layer-relaunch',
    '--user-data-dir=' + browserProfile, '--virtual-time-budget=1000', '--dump-dom', pathToFileURL(value.entry).href],
    { cwd: root, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  const document = parse(stdout);
  for (const [selector, text] of expectedTexts) {
    const node = nodeBy(document, value => selector === 'h1' ? value.tagName === 'h1' : value.attrs?.some(a => a.name === 'id' && a.value === selector.slice(1)));
    assert.ok(node, selector); assert.equal(textOf(node), text);
  }
  const html = nodeBy(document, value => value.tagName === 'html');
  const attr = name => html.attrs.find(value => value.name === name)?.value;
  assert.equal(attr('data-script-ran'), '17', 'existing source script runs on independent reopening');
  assert.equal(attr('data-brand-color'), 'rgb(12, 34, 56)', 'unchanged external CSS loads in the independent browser');
  assert.match(attr('data-browser'), /Edg\//);
  return attr('data-browser');
}

test('M2 product recovery, reviewed Save, independent browser and conflict-copy path', { timeout: 240000 }, async t => {
  await mkdir(results, { recursive: true });
  const passed = []; const evidence = {};
  const report = { status: 'running', passed, platform: { os: type(), release: release(), arch: arch() }, evidence,
    pending: ['maintainer independent task', 'real Windows IME and native chooser interaction', 'Windows 10 / DPI / screen reader'] };
  const saveReport = () => writeFile(join(results, 'product-acceptance.json'), JSON.stringify(report, null, 2));
  await saveReport();
  if (process.platform !== 'win32') {
    report.status = 'unavailable'; await saveReport(); t.skip('Windows product acceptance requires Windows and an installed Edge browser.'); return;
  }
  try {
    const value = await fixture(); report.case = value.base;
    const seed = launch(t, 'seed', value);
    const seeded = await seed.receipt('seeded');
    assert.equal(seeded.history.undoCount, 5);
    assert.deepEqual(await readFile(value.entry), Buffer.from(source));
    seed.child.kill('SIGKILL'); const interrupted = await seed.exited();
    assert.notEqual(interrupted.code, 0);
    const restoring = launch(t, 'restore-save', value, seeded.sessionId);
    const saved = await restoring.receipt('saved');
    await restoring.receipt('closing'); assert.deepEqual(await restoring.exited(), {code: 0, signal: null});
    assert.deepEqual(await readFile(value.entry), expected());
    assert.deepEqual(await readFile(join(value.project, 'keep.css')), Buffer.from(css));
    passed.push('five real product edits survive a killed Main; recovery cancellation/wrong file preserve source, UI recovery and reviewed native Save produce exact bytes');
    evidence.savedHash = hash(expected()); evidence.savedBrowser = await browserReopen(value, edits);
    passed.push('independent installed Edge reopens the saved report with five correct fields, original script execution and unchanged CSS');
    const afterSave = launch(t, 'saved-backup', value, saved.sessionId);
    const undoSaved = await afterSave.receipt('undo-saved');
    assert.equal(undoSaved.hash, hash(expected(4))); evidence.undoSavedHash = undoSaved.hash;
    await afterSave.receipt('backup-restored');
    const closing = await afterSave.receipt('closing'); report.versions = closing.versions;
    assert.deepEqual(await afterSave.exited(), {code: 0, signal: null});
    assert.deepEqual(await readFile(value.entry), Buffer.from(source));
    evidence.restoredBrowser = await browserReopen(value, [['h1','年度 A 报告 😀'],['#date','2025-01-01'],['#label','一 & 二'],['#amount','1000.00'],['#memo','原摘要']]);
    passed.push('a clean product restart restores saved history; Undo requires a second reviewed Save, Redo remains available, and confirmed backup restoration returns exact original HTML');
    const conflictValue = await fixture();
    const conflict = launch(t, 'conflict', conflictValue);
    await conflict.receipt('await-conflict');
    const external = Buffer.from(source.replace('原始备注', '外部程序更新'));
    await writeFile(conflictValue.entry, external);
    const copied = await conflict.receipt('conflict-copied');
    assert.equal(copied.changes, 1); assert.equal(copied.code, 'FILE_CHANGED'); evidence.conflictCode = copied.code;
    await conflict.receipt('closing'); assert.deepEqual(await conflict.exited(), {code: 0, signal: null});
    assert.deepEqual(await readFile(conflictValue.entry), external);
    assert.deepEqual(await readFile(join(conflictValue.project, '冲突草稿.html')), expected(1));
    assert.deepEqual(await readFile(join(conflictValue.project, 'keep.css')), Buffer.from(css));
    passed.push('a separate process changes the open file; product Save rejects the conflict and product copy preserves the draft without overwriting external bytes');
    const directoryValue = await fixture(true);
    const directorySeed = launch(t, 'seed', directoryValue);
    const directorySeeded = await directorySeed.receipt('seeded');
    assert.equal(directorySeeded.history.undoCount, 5);
    assert.deepEqual(await readFile(directoryValue.entry), Buffer.from(directoryValue.source));
    directorySeed.child.kill('SIGKILL'); assert.notEqual((await directorySeed.exited()).code, 0);
    const limited = launch(t, 'file-limited', directoryValue, directorySeeded.sessionId);
    const limitedProof = await limited.receipt('file-limited');
    assert.equal(limitedProof.parentResourceLoaded, false);
    assert.equal(limitedProof.changes, 5);
    assert.equal(limitedProof.sessionId, directorySeeded.sessionId);
    assert.deepEqual(await readFile(directoryValue.entry), Buffer.from(directoryValue.source));
    limited.child.kill('SIGKILL'); assert.notEqual((await limited.exited()).code, 0);
    passed.push('a nested project survives Main termination; default file recovery stays within the entry folder and does not silently restore parent resource authorization');
    const directoryRestore = launch(t, 'restore-save', directoryValue, directorySeeded.sessionId);
    const directoryRestored = await directoryRestore.receipt('directory-reauthorized');
    assert.equal(directoryRestored.fileChoices, 0);
    assert.equal(directoryRestored.rootChoices, 7);
    assert.equal(directoryRestored.entryChoices, 5);
    assert.equal(directoryRestored.projectEntry, 'pages/报告.html');
    assert.equal(directoryRestored.parentResourceLoaded, true);
    passed.push('real recovery controls support directory selection by keyboard, 960x640 layout, chooser cancellations and wrong targets, retain selection, and exclude duplicate/close/Escape/Ctrl+O competition');
    await directoryRestore.receipt('saved'); await directoryRestore.receipt('closing');
    assert.deepEqual(await directoryRestore.exited(), {code: 0, signal: null});
    const directoryExpected = expected(5, directoryValue.source);
    assert.deepEqual(await readFile(directoryValue.entry), directoryExpected);
    assert.deepEqual(await readFile(directoryValue.cssPath), Buffer.from(css));
    evidence.directory = { fileMode: limitedProof, directoryMode: directoryRestored, savedHash: hash(directoryExpected),
      browser: await browserReopen(directoryValue, edits), case: directoryValue.base };
    passed.push('fresh directory authorization restores five drafts and shared CSS; reviewed native Save changes only the expected HTML bytes and an independent Edge process reopens the nested report');
    report.status = 'passed';
    report.commit = (await execute('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim();
    report.dirty = !!(await execute('git',['status','--porcelain'],{cwd:root})).stdout.trim();
    evidence.originalHash = hash(Buffer.from(source)); evidence.cssHash = hash(Buffer.from(css));
    await saveReport();
    for (const value of passed) console.log('PASS: ' + value);
  } catch (error) {
    report.status = 'failed'; report.error = String(error); await saveReport(); throw error;
  }
});
