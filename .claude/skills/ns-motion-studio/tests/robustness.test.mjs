// 公開前のレビューで見つかった、壊れ方の点検（ブラウザも ffmpeg も使わない）。
// 書き出しが止まったままにならない、時刻表を書き換える道具が鍵を取る、Windows の上書きのやり直し、書き出しの前の時刻表の検査、
// 点検の終了コードの区別、確認ページの開き方、書体の取り込み。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fetchFont } from '../scripts/fonts.mjs';
import { copyTree, replaceFile } from '../scripts/paths.mjs';
import { writeFrame } from '../scripts/render.mjs';
import { openArgs } from '../scripts/review-page.mjs';
import { assertValidTimeline } from '../scripts/timeline.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/sample/', import.meta.url));
const run = (name, ...args) => spawnSync(process.execPath, [path.join(SCRIPTS, name), ...args], { encoding: 'utf8' });

/** 見本の制作フォルダを、日本語と空白を含む一時フォルダへ写す */
function copySample() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 堅牢-')), '新製品 紹介');
  copyTree(SAMPLE, dir);
  return dir;
}

/** 生きているプロセス（このテスト）の鍵を置く */
function lockBy(dir, label = 'render.mjs') {
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', '.lock'), JSON.stringify({ pid: process.pid, label, startedAt: new Date().toISOString() }));
}

test('writeFrame: ffmpeg が先に終わっていたら、待ち続けずに失敗する', async () => {
  const proc = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const done = new Promise((resolve, reject) => proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg が失敗しました（終了コード ${code}）`)))));
  done.catch(() => {});
  await new Promise((r) => proc.on('close', r));
  const big = Buffer.alloc(8 << 20);
  const result = await Promise.race([
    writeFrame({ proc, done }, big).then(() => 'resolved', (e) => `rejected: ${e.message}`),
    new Promise((r) => setTimeout(() => r('hung'), 3000)),
  ]);
  assert.match(result, /^rejected: ffmpeg/);
});

test('時刻表を書き換える道具（narration・gemini bgm・mix）と check --waive は、ほかの実行中は断る', () => {
  const dir = copySample();
  lockBy(dir);
  const cases = [
    ['narration.mjs', dir, '--engine', 'voicevox', '--speaker', '2'],
    ['gemini.mjs', 'bgm', dir, '--prompt', 'calm'],
    ['mix.mjs', dir],
    ['check.mjs', dir, '--waive', '1', '--why', 'x'],
  ];
  for (const [name, ...args] of cases) {
    const r = run(name, ...args);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /render\.mjs が実行中です/, `${name}: ${r.stderr}`);
  }
});

test('narration と gemini bgm は、時刻表を一時ファイル経由で書く（書きかけを読まれない）', () => {
  for (const name of ['narration.mjs', 'gemini.mjs']) {
    const src = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    assert.doesNotMatch(src, /writeFileSync\(tlFile/, name);
    assert.match(src, /writeTimeline\(/, name);
  }
});

test('replaceFile: Windows で一時的に握られた（EPERM・EBUSY）ときは待ってやり直し、駄目なら閉じるよう日本語で伝える', () => {
  let n = 0;
  const flaky = () => { if (n++ < 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  replaceFile('a', 'b', { rename: flaky, waitMs: 1 });
  assert.equal(n, 3);
  const stuck = () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
  assert.throws(() => replaceFile('a', 'C:/x/完成版.mp4', { rename: stuck, waitMs: 1 }), /完成版\.mp4.*閉じて/s);
  const other = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.throws(() => replaceFile('a', 'b', { rename: other, waitMs: 1 }), /ENOENT/);
});

test('assertValidTimeline: 誤りがあれば、書き出しの前に日本語でまとめて止める', () => {
  const dir = copySample();
  assert.equal(assertValidTimeline(dir).title, '見本');
  const tl = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ ...tl, scenes: [] }));
  assert.throws(() => assertValidTimeline(dir), /timeline\.json に誤りがあります/);
});

test('render と assemble は、時刻表に誤りがあれば書き出す前に終了コード 1 で止まる', () => {
  const dir = copySample();
  const tl = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ ...tl, scenes: [] }));
  for (const name of ['render.mjs', 'assemble.mjs']) {
    const r = run(name, dir, ...(name === 'render.mjs' ? ['--estimate'] : []));
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /timeline\.json に誤りがあります/, name);
  }
});

test('check.mjs は、点検そのものが動かなかったとき（例外）は終了コード 4（問題ありの 1 と分ける）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 堅牢-'));
  const r = run('check.mjs', dir);
  assert.equal(r.status, 4, r.stderr);
});

test('openArgs: Windows はシェルを通さずに開く（パスの % や & が崩れない）', () => {
  const abs = 'C:\\Users\\a\\100% 確認 & 修正\\reviews\\briefing.html';
  const [cmd, args, extra] = openArgs(abs, 'win32');
  assert.equal(cmd, 'explorer.exe');
  // シェルを通さないので %名前% は展開されない。引用符で囲んだ1つの引数として渡す
  assert.deepEqual(args, [`"${abs}"`]);
  assert.ok(!extra.shell);
  assert.deepEqual(openArgs('/x/a.html', 'darwin').slice(0, 2), ['open', ['/x/a.html']]);
});

const CSS = (url = 'https://fonts.gstatic.com/s/a.woff2') => `@font-face {
  font-family: 'Noto Sans JP';
  font-weight: 400;
  src: url(${url}) format('woff2');
}`;
const fakeFetch = (css, seen = []) => async (url, init) => {
  seen.push({ url: String(url), signal: init?.signal });
  return String(url).includes('css2')
    ? { ok: true, text: async () => css }
    : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
};

test('fetchFont: 同じ書体を取り込み直すと、fonts.css の定義は置き換わる（重ならない）', async () => {
  const dir = copySample();
  await fetchFont(dir, 'Noto Sans JP', [400], { fetch: fakeFetch(CSS()) });
  await fetchFont(dir, 'Noto Sans JP', [400], { fetch: fakeFetch(CSS()) });
  const css = fs.readFileSync(path.join(dir, 'assets/fonts/fonts.css'), 'utf8');
  assert.equal(css.match(/family="Noto Sans JP"/g).length, 1, css);
  assert.equal(css.match(/@font-face/g).length, 1, css);
});

test('fetchFont: 書体のファイルは https://fonts.gstatic.com/ からだけ取り、通信には時間切れを付ける', async () => {
  const seen = [];
  await assert.rejects(fetchFont(copySample(), 'Noto Sans JP', [400], { fetch: fakeFetch(CSS('http://example.com/a.woff2'), seen) }), /取得先/);
  assert.ok(seen.every((s) => !s.url.startsWith('http://example.com')), '外の取得先には取りに行かない');
  assert.ok(seen[0].signal, 'css の取得に時間切れの signal');
});

test('fetchFont: 取り込み直しても、手で書いたほかの書体の @font-face は消さない', async () => {
  const dir = copySample();
  await fetchFont(dir, 'Noto Sans JP', [400], { fetch: fakeFetch(CSS()) });
  const cssFile = path.join(dir, 'assets/fonts/fonts.css');
  fs.appendFileSync(cssFile, "@font-face {\n  font-family: 'Brand Sans';\n  src: url(./brand.woff2);\n}\n");
  await fetchFont(dir, 'Noto Sans JP', [400, 700], { fetch: fakeFetch(CSS()) });
  const css = fs.readFileSync(cssFile, 'utf8');
  assert.match(css, /Brand Sans/, css);
  assert.equal(css.match(/family="Noto Sans JP"/g).length, 1, css);
  assert.equal(css.match(/font-family: 'Noto Sans JP'/g).length, 1, css);
});

test('assemble と render は、宣言（settings.intent）に timeline.json に無いシーンがあれば、書き出す前に止まる', () => {
  const dir = copySample();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ title: 't', stage: 'build', gates: {}, settings: { course: 'full', kind: '', fps: 30,
    ratios: ['16:9'], loop: false, audio: { narration: 'none', bgm: 'none', sfx: false },
    intent: [{ check: 'hold', why: 'x', scenes: ['s99'], addedAt: 'a', stage: 'build' }] }, models: [] }));
  for (const name of ['assemble.mjs', 'render.mjs']) {
    const r = run(name, dir, ...(name === 'render.mjs' ? ['--estimate'] : []));
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /s99/, name);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'out', '.scenes')));
});
