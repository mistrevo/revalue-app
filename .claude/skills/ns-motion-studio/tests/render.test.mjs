// シーンの書き出し（render.mjs）を、fixture を一時フォルダへ複製して検証する。道具が無ければ飛ばす。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyTree, removeTree, toolsDir } from '../scripts/paths.mjs';
import { encodeArgs, estimate, exitCodeOf, recordAssembleStats, recordStats, renderAll, renderLimit, renderScene, sceneHash, seamScene, SEAM_X264_PARAMS } from '../scripts/render.mjs';
import { setSceneDuration } from '../scripts/timeline.mjs';
import { bundledBinary, defaultExec, hasPackage, loadPuppeteer } from '../scripts/tools.mjs';

const SAMPLE = fileURLToPath(new URL('./fixtures/sample/', import.meta.url));
const HAS_TOOLS = hasPackage(toolsDir(), 'puppeteer')
  && (defaultExec('ffmpeg -version') !== null || bundledBinary(toolsDir(), 'ffmpeg-static') !== null)
  && (defaultExec('ffprobe -version') !== null || bundledBinary(toolsDir(), 'ffprobe-static') !== null);

/** fixture を、日本語と空白を含む名前の一時フォルダへ複製する */
function copySample() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 書き出し-'));
  copyTree(SAMPLE, dir);
  return dir;
}

const sceneOut = (dir, id, preset = 'draft') => path.join(dir, 'out/.scenes', preset, '16x9', `${id}.mp4`);

function probe(file) {
  const ffprobe = defaultExec('ffprobe -version') !== null ? 'ffprobe' : bundledBinary(toolsDir(), 'ffprobe-static');
  const r = spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames,pix_fmt,codec_name', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).streams[0];
}

/** @type {any} */
let browser;
const dirs = [];
before(async () => {
  if (!HAS_TOOLS) return;
  browser = await loadPuppeteer().launch({ headless: 'shell', args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
});
after(async () => {
  await browser?.close();
  for (const d of dirs) removeTree(d);
});

function toolTest(name, fn) {
  test(name, async (t) => {
    if (!HAS_TOOLS) return t.skip('道具が未導入');
    const dir = copySample();
    dirs.push(dir);
    await fn(t, dir);
  });
}

test('計測が無ければ、ラフ版は1フレーム 0.05 秒、全品質は 0.065 秒で見積もり、音とつなぎに 30 秒と動画1秒あたり 0.06 秒を足す', () => {
  const dir = copySample();
  dirs.push(dir);
  // 見本は 3 秒の動画
  assert.deepEqual(estimate(dir, { ratios: ['16:9'], preset: 'draft' }), { frames: 90, toRender: 90, seconds: 4.5, assembleSeconds: 30.18 });
  assert.deepEqual(estimate(dir, { ratios: ['16:9', '1:1'], preset: 'final' }), { frames: 180, toRender: 180, seconds: 11.7, assembleSeconds: 30.18 });
  // 254 秒の動画は約 45 秒（試作で 43 秒かかった）
  const tlFile = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl.scenes[1].end = 254;
  fs.writeFileSync(tlFile, JSON.stringify(tl));
  assert.equal(estimate(dir, { ratios: ['16:9'], preset: 'final' }).assembleSeconds, 45.24);
});

test('全品質の計測がまだ無くラフ版の計測があれば、ラフ版の 1.25 倍で見積もる。つなぎの計測があればそれを使う', () => {
  const dir = copySample();
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'out/.scenes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out/.scenes/stats.json'), JSON.stringify({
    'draft/16:9': { secondsPerFrame: 0.04, frames: 10, seconds: 0.4 },
    'assemble/final': { secondsPerVideoSecond: 2, seconds: 6, videoSeconds: 3 },
  }));
  const est = estimate(dir, { ratios: ['16:9'], preset: 'final' });
  assert.equal(est.toRender, 90); // 見本は 30fps・3 秒
  assert.ok(Math.abs(est.seconds - 90 * 0.05) < 1e-6, String(est.seconds));
  assert.equal(est.assembleSeconds, 6);
  // ラフ版のつなぎの計測は無いので、既定（30 秒と動画1秒あたり 0.06 秒）
  assert.equal(estimate(dir, { ratios: ['16:9'], preset: 'draft' }).assembleSeconds, 30.18);
});

test('stats.json は、preset と比率ごとにフレーム数と秒数を足し合わせ、合計から1フレームあたりの秒数を出す', () => {
  const dir = copySample();
  dirs.push(dir);
  recordStats(dir, 'draft', '16:9', 100, 4);
  recordStats(dir, 'draft', '16:9', 300, 6);
  recordStats(dir, 'final', '16:9', 10, 1);
  recordAssembleStats(dir, 'final', 3, 3);
  recordAssembleStats(dir, 'final', 1, 9);
  const stats = JSON.parse(fs.readFileSync(path.join(dir, 'out/.scenes/stats.json'), 'utf8'));
  assert.deepEqual(stats['draft/16:9'], { secondsPerFrame: 10 / 400, frames: 400, seconds: 10 });
  assert.deepEqual(stats['final/16:9'], { secondsPerFrame: 0.1, frames: 10, seconds: 1 });
  assert.deepEqual(stats['assemble/final'], { secondsPerVideoSecond: 4 / 12, seconds: 4, videoSeconds: 12 });
});

test('sceneHash は preset・比率・シーンの HTML で変わり、同じ入力なら同じ', () => {
  const dir = copySample();
  dirs.push(dir);
  const h = sceneHash(dir, 's01', '16:9', 'draft');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(sceneHash(dir, 's01', '16:9', 'draft'), h);
  assert.notEqual(sceneHash(dir, 's01', '16:9', 'final'), h);
  assert.notEqual(sceneHash(dir, 's01', '1:1', 'draft'), h);
  fs.mkdirSync(path.join(dir, 'assets/fonts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/fonts/fonts.css'), '/* x */');
  const withFonts = sceneHash(dir, 's01', '16:9', 'draft');
  assert.notEqual(withFonts, h, 'fonts.css の中身も入る');

  // シーンが参照する assets は、中身が変われば鍵も変わる
  const html = path.join(dir, 'src/scenes/s01.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<div id="dots"></div>', '<div id="dots"></div><img src="../../assets/ロゴ 画像.png?v=1">'));
  fs.writeFileSync(path.join(dir, 'assets/ロゴ 画像.png'), 'a');
  const withLogo = sceneHash(dir, 's01', '16:9', 'draft');
  fs.writeFileSync(path.join(dir, 'assets/ロゴ 画像.png'), 'b');
  assert.notEqual(sceneHash(dir, 's01', '16:9', 'draft'), withLogo);
  assert.equal(sceneHash(dir, 's02', '16:9', 'draft'), sceneHash(dir, 's02', '16:9', 'draft'));

  // src/ の下の共通の部品（JS の import などで読むもの）は、参照が見えなくても鍵に入る
  const s01 = sceneHash(dir, 's01', '16:9', 'draft');
  fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/lib/motion.js'), 'export const a = 1;');
  const withLib = sceneHash(dir, 's01', '16:9', 'draft');
  assert.notEqual(withLib, s01);
  // ほかのシーンの HTML を変えても、s01 の鍵は変わらない
  const s02html = path.join(dir, 'src/scenes/s02.html');
  fs.writeFileSync(s02html, fs.readFileSync(s02html, 'utf8') + '\n<!-- 変更 -->');
  assert.equal(sceneHash(dir, 's01', '16:9', 'draft'), withLib);
  // seed が変われば鍵も変わる
  const file = path.join(dir, 'timeline.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), seed: 2 }));
  assert.notEqual(sceneHash(dir, 's01', '16:9', 'draft'), withLib);
});

test('ループの動画では、最初と最後のシーンだけを継ぎ目用の圧縮にし、鍵にも入れる', () => {
  const dir = copySample();
  dirs.push(dir);
  const file = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(file, 'utf8'));
  const three = { ...tl, scenes: [...tl.scenes, { id: 's03', start: 3, end: 4, file: 'src/scenes/s03.html' }] };
  assert.equal(seamScene(three, 's01'), false, 'loop が false なら継ぎ目は無い');
  const looped = { ...three, loop: true };
  assert.deepEqual(['s01', 's02', 's03'].map((id) => seamScene(looped, id)), [true, false, true]);

  const spec = { fps: 30, outWidth: 1920, outHeight: 1080 };
  const plain = encodeArgs(spec, 'final', 'out.mp4');
  assert.ok(!plain.includes('-x264-params'));
  const seam = encodeArgs(spec, 'final', 'out.mp4', { seam: true });
  assert.equal(seam[seam.indexOf('-x264-params') + 1], SEAM_X264_PARAMS);
  assert.equal(SEAM_X264_PARAMS, 'mbtree=0:aq-mode=0');

  const before = sceneHash(dir, 's01', '16:9', 'final');
  fs.writeFileSync(file, JSON.stringify({ ...tl, loop: true }));
  assert.notEqual(sceneHash(dir, 's01', '16:9', 'final'), before, '継ぎ目になったシーンは描き直す');
});

test('loop を true にしても、継ぎ目でない（最初でも最後でもない）シーンの鍵は変わらない', () => {
  const dir = copySample();
  dirs.push(dir);
  const file = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 3 つ目のシーンを足し、s02 を真ん中にする
  fs.copyFileSync(path.join(dir, 'src/scenes/s02.html'), path.join(dir, 'src/scenes/s03.html'));
  const three = { ...tl, scenes: [...tl.scenes, { id: 's03', start: 3, end: 4, purpose: 'CTA', file: 'src/scenes/s03.html' }] };
  fs.writeFileSync(file, JSON.stringify(three));
  const hashes = () => ['s01', 's02', 's03'].map((id) => sceneHash(dir, id, '16:9', 'final'));
  const before = hashes();
  fs.writeFileSync(file, JSON.stringify({ ...three, loop: true }));
  const after = hashes();
  assert.equal(after[1], before[1], '真ん中のシーンは描き直さない');
  assert.notEqual(after[0], before[0]);
  assert.notEqual(after[2], before[2]);
});

test('前のシーンの尺がコマの長さの倍数で変わり、後ろへずれただけのシーンは、鍵が変わらない（描き直さない）', () => {
  const dir = copySample();
  dirs.push(dir);
  const file = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(file, 'utf8'));
  /** s01 を d 秒伸ばし、s02 とそのテキスト・効果音を d 秒後ろへずらす */
  const shift = (d) => fs.writeFileSync(file, JSON.stringify({
    ...tl,
    scenes: [{ ...tl.scenes[0], end: 1.5 + d }, { ...tl.scenes[1], start: 1.5 + d, end: 3 + d }],
    texts: tl.texts.map((t) => (t.scene === 's02' ? { ...t, start: t.start + d, end: t.end + d } : t)),
    sfx: tl.sfx.map((x) => ({ ...x, t: x.t + d })),
  }));
  const hashes = () => ['draft', 'final'].flatMap((p) => ['s01', 's02'].map((id) => sceneHash(dir, id, '16:9', p)));
  const [d1, d2, f1, f2] = hashes();
  shift(0.5); // 30fps で 15 コマ
  const [e1, e2, g1, g2] = hashes();
  assert.notEqual(e1, d1, '伸ばしたシーンは描き直す');
  assert.notEqual(g1, f1);
  assert.equal(e2, d2, 'ずれただけのシーンは描き直さない（ラフ版）');
  assert.equal(g2, f2, 'ずれただけのシーンは描き直さない（完成版）');
  shift(0.51); // コマの格子とシーンの先頭のずれが変わる
  const [, h2, , i2] = hashes();
  assert.notEqual(h2, d2, '格子とのずれが変われば描き直す');
  assert.notEqual(i2, f2);
});

toolTest('draft で書き出すと 960×540・30fps・round(終了×30) − round(開始×30) フレームの MP4 になり、同じ条件なら描き直さない', async (_t, dir) => {
  const r = await renderScene(dir, 's01', { ratio: '16:9', preset: 'draft', browser });
  assert.equal(r.cached, false);
  assert.equal(r.frames, Math.round(1.5 * 30) - Math.round(0 * 30));
  assert.equal(r.file, sceneOut(dir, 's01'));
  const s = probe(r.file);
  assert.equal(s.codec_name, 'h264');
  assert.equal(s.pix_fmt, 'yuv420p');
  assert.equal(s.width, 960);
  assert.equal(s.height, 540);
  assert.equal(s.r_frame_rate, '30/1');
  assert.equal(Number(s.nb_read_frames), 45);

  const again = await renderScene(dir, 's01', { ratio: '16:9', preset: 'draft', browser });
  assert.equal(again.cached, true);
  assert.equal(again.frames, 45);

  // 書き出し時間を stats.json に残し、見積もりに使う
  const stats = JSON.parse(fs.readFileSync(path.join(dir, 'out/.scenes/stats.json'), 'utf8'));
  const spf = stats['draft/16:9'].secondsPerFrame;
  assert.ok(spf > 0);
  const est = estimate(dir, { ratios: ['16:9'], preset: 'draft' });
  assert.equal(est.frames, 90);
  // s01（45 フレーム）は前回のまま使えるので、書き出すのは s02 の 45 フレームだけ
  assert.equal(est.toRender, 45);
  assert.ok(Math.abs(est.seconds - 45 * spf) < 1e-5);

  // HTML を1文字変えると描き直す
  const html = path.join(dir, 'src/scenes/s01.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<title>s01</title>', '<title>s01!</title>'));
  const changed = await renderScene(dir, 's01', { ratio: '16:9', preset: 'draft', browser });
  assert.equal(changed.cached, false);
});

/** シーン s01 が、JS のテンプレート文字列で組んだパスから assets/ の画像を読むようにする（HTML の参照からは見えない） */
function loadAssetByTemplate(dir) {
  const html = path.join(dir, 'src/scenes/s01.html');
  const js = "\n  const n = 'screen';\n  const img = new Image(); img.src = `../../assets/shots/${n}.png`; document.body.appendChild(img);";
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<script>', `<script>${js}`));
  fs.mkdirSync(path.join(dir, 'assets/shots'), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/loop-edge.png', import.meta.url)), path.join(dir, 'assets/shots/screen.png'));
}

test('sceneHash は、JS のテンプレート文字列で読む assets/ の画像を差し替えても変わる（参照が見えなくても assets/ を丸ごと入れる）', () => {
  const dir = copySample();
  dirs.push(dir);
  loadAssetByTemplate(dir);
  const h = sceneHash(dir, 's01', '16:9', 'draft');
  fs.appendFileSync(path.join(dir, 'assets/shots/screen.png'), Buffer.from('changed'));
  assert.notEqual(sceneHash(dir, 's01', '16:9', 'draft'), h);
});

toolTest('JS のテンプレート文字列で読む画像を差し替えると、前回のままにせず描き直す', async (t, dir) => {
  loadAssetByTemplate(dir);
  assert.equal((await renderScene(dir, 's01', { ratio: '16:9', preset: 'draft', browser })).cached, false);
  assert.equal((await renderScene(dir, 's01', { ratio: '16:9', preset: 'draft', browser })).cached, true);
  fs.appendFileSync(path.join(dir, 'assets/shots/screen.png'), Buffer.from('changed'));
  assert.equal((await renderScene(dir, 's01', { ratio: '16:9', preset: 'draft', browser })).cached, false);
});

/** 尺 1.01 秒のシーンを3つ並べた制作フォルダにする（境目がフレームの格子に乗らない） */
function threeScenes(dir, fps) {
  const file = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(file, 'utf8'));
  tl.fps = fps;
  tl.scenes = ['s01', 's02', 's03'].map((id, i) => ({ id, start: i * 1.01, end: Math.round((i + 1) * 1.01 * 100) / 100, file: `src/scenes/${id}.html` }));
  tl.texts = ['s01', 's02', 's03'].map((scene, i) => ({ id: `t0${i + 1}`, scene, kind: 'title', text: 'あ', start: i * 1.01 + 0.1, end: i * 1.01 + 0.9 }));
  tl.sfx = [];
  tl.poster = 0.5;
  fs.writeFileSync(file, JSON.stringify(tl, null, 2));
  const s02 = fs.readFileSync(path.join(dir, 'src/scenes/s02.html'), 'utf8');
  fs.writeFileSync(path.join(dir, 'src/scenes/s03.html'), s02.replaceAll('t02', 't03'));
}

test('境目がフレームの格子に乗らなくても、シーンごとのフレーム数の和は round(総尺 × fps) になる', () => {
  const dir = copySample();
  dirs.push(dir);
  threeScenes(dir, 60);
  assert.equal(estimate(dir, { ratios: ['16:9'], preset: 'final' }).frames, Math.round(3.03 * 60)); // 182（切り上げなら 183）
  assert.equal(estimate(dir, { ratios: ['16:9'], preset: 'draft' }).frames, Math.round(3.03 * 30)); // 91（切り上げなら 93）
});

toolTest('境目が格子に乗らない3シーンを書き出すと、各 MP4 のフレーム数の和が round(総尺 × 30) になる', async (_t, dir) => {
  threeScenes(dir, 30);
  const results = await renderAll(dir, { ratios: ['16:9'], preset: 'draft', browser });
  assert.deepEqual(results.map((r) => r.frames), [30, 31, 30]);
  const total = results.reduce((sum, r) => sum + Number(probe(r.file).nb_read_frames), 0);
  assert.equal(total, Math.round(3.03 * 30));
});

toolTest('s01 の尺をコマの長さの倍数で変えると s01 だけを描き直し、倍数でなければ s02 も描き直す', async (_t, dir) => {
  const first = await renderAll(dir, { ratios: ['16:9'], preset: 'draft', browser });
  assert.deepEqual(first.map((x) => [x.sceneId, x.cached]), [['s01', false], ['s02', false]]);
  const second = await renderAll(dir, { ratios: ['16:9'], preset: 'draft', browser });
  assert.deepEqual(second.map((x) => x.cached), [true, true]);

  const file = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(setSceneDuration(tl, 's01', 2.0), null, 2));
  const third = await renderAll(dir, { ratios: ['16:9'], preset: 'draft', browser });
  // 0.5 秒（30fps で 15 コマ）ずれただけの s02 は、前回の MP4 を使う
  assert.deepEqual(third.map((x) => x.cached), [false, true]);
  assert.equal(third[0].frames, 60);
  assert.equal(third[1].frames, 45);
  // コマの格子とのずれが変わると、s02 も描き直す
  fs.writeFileSync(file, JSON.stringify(setSceneDuration(tl, 's01', 2.01), null, 2));
  const fourth = await renderAll(dir, { ratios: ['16:9'], preset: 'draft', browser });
  assert.deepEqual(fourth.map((x) => x.cached), [false, false]);
});

toolTest('onProgress の例外で中断すると、途中のファイルも完成名のファイルも残らない', async (_t, dir) => {
  const stop = new Error('止める');
  await assert.rejects(
    renderScene(dir, 's01', {
      ratio: '16:9', preset: 'draft', browser,
      onProgress: ({ frame }) => { if (frame === 5) throw stop; },
    }),
    (e) => e === stop,
  );
  const outDir = path.dirname(sceneOut(dir, 's01'));
  const left = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  assert.deepEqual(left.filter((f) => f.startsWith('s01')), []);
});

test('書き出しの上限は、見込みの2倍か、見込み + 60 秒の長いほう', () => {
  assert.equal(renderLimit(10), 70);
  assert.equal(renderLimit(60), 120);
  assert.equal(renderLimit(100), 200);
});

toolTest('書き出しが上限を超えたら、途中のシーンを捨てて止め、書き終えたシーンは残す。同じコマンドで残りから再開する', async (_t, dir) => {
  let now = 0;
  await assert.rejects(
    renderAll(dir, {
      ratios: ['16:9'], preset: 'draft', browser, clock: () => now,
      // s02 を描いている途中で、時計を上限の先へ進める
      onProgress: ({ sceneId, frame }) => { if (sceneId === 's02' && frame === 3) now = 1000; },
    }),
    (e) => {
      assert.match(e.message, /見込み（約 \d+ 秒）の2倍を超えたので止めました/);
      assert.match(e.message, /かかった時間（約 1000 秒）/);
      assert.match(e.message, /新しい見込み（残り約 \d+ 秒）/);
      assert.match(e.message, /利用者に伝えてから/);
      assert.match(e.message, /同じコマンド/);
      assert.match(e.message, /この実行で書き終えた 1 シーン/);
      assert.equal(e.code, 'RENDER_LIMIT');
      return true;
    },
  );
  assert.ok(fs.existsSync(sceneOut(dir, 's01')));
  assert.deepEqual(fs.readdirSync(path.dirname(sceneOut(dir, 's01'))).filter((f) => f.startsWith('s02')), []);
  // 止めた s02 の途中まで（3 フレーム）の計測も残す
  const stats = JSON.parse(fs.readFileSync(path.join(dir, 'out/.scenes/stats.json'), 'utf8'));
  assert.equal(stats['draft/16:9'].frames, 45 + 3);
  const again = await renderAll(dir, { ratios: ['16:9'], preset: 'draft', browser });
  assert.deepEqual(again.map((x) => [x.sceneId, x.cached]), [['s01', true], ['s02', false]]);
});

toolTest('この実行で最初に描くシーンは、上限を超えても止めずに書き終えるので、再実行で必ず進む', async (_t, dir) => {
  // 始めた直後から、ずっと上限の先にある時計
  const late = () => { let calls = 0; return () => (calls++ === 0 ? 0 : 1e6); };
  await assert.rejects(renderAll(dir, { ratios: ['16:9'], preset: 'draft', browser, clock: late() }), /この実行で書き終えた 1 シーン/);
  assert.ok(fs.existsSync(sceneOut(dir, 's01')));
  // 再実行では s02 が最初に描くシーンなので、同じ時計でも書き終える
  const again = await renderAll(dir, { ratios: ['16:9'], preset: 'draft', browser, clock: late() });
  assert.deepEqual(again.map((x) => [x.sceneId, x.cached]), [['s01', true], ['s02', false]]);
});

test('上限で止めた書き出しの終了コードは 3（点検の 1・2 と見分ける）', () => {
  assert.equal(exitCodeOf(Object.assign(new Error('x'), { code: 'RENDER_LIMIT' })), 3);
  assert.equal(exitCodeOf(new Error('x')), 1);
});

toolTest('読み込めないフォントがあれば、シーン名とフォント名を書いた日本語の例外にする', async (_t, dir) => {
  const html = path.join(dir, 'src/scenes/s02.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('</style>', '.title { font-family: "存在しない書体"; }\n</style>'));
  await assert.rejects(
    renderScene(dir, 's02', { ratio: '16:9', preset: 'draft', browser }),
    /s02.*存在しない書体/,
  );
});

toolTest('シーンのページは、制作フォルダの外の読み込み（http と、外のファイル）を止め、書き出しを日本語で断る', async (t, dir) => {
  const { openPage } = await import('../scripts/render.mjs');
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 外-')), 'secret.png');
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/loop-edge.png', import.meta.url)), outside);
  const file = path.join(dir, 'src/scenes/s01.html');
  const outsideUrl = pathToFileURL(outside).href;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('</body>', `<img src="${outsideUrl}"><img src="http://127.0.0.1:9/x.png"></body>`));
  const spec = { width: 1920, height: 1080, scale: 1 };
  await assert.rejects(openPage(browser, dir, 's01', '16:9', spec), /制作フォルダの外/);
  // 中のファイルは読める（見本のシーン s02 はそのまま開ける）
  const page = await openPage(browser, dir, 's02', '16:9', spec);
  await page.close();
});
