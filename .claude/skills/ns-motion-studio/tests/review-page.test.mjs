// 確認ページ（review-page.mjs）。fixture を一時フォルダへ複製し、関門ごとの HTML を作って中身を確かめる。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logFeedback, markResolved } from '../scripts/feedback.mjs';
import { copyTree, toolsDir } from '../scripts/paths.mjs';
import { initProject, readProject, writeProject } from '../scripts/project.mjs';
import { buildReviewPage, copyText, formatClock, renderMarkdown, showPage } from '../scripts/review-page.mjs';
import { hasPackage, loadPuppeteer } from '../scripts/tools.mjs';

const SAMPLE = fileURLToPath(new URL('./fixtures/sample/', import.meta.url));

/** fixture を、日本語と空白を含む名前の一時フォルダへ複製する */
function copySample() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 確認-'));
  copyTree(SAMPLE, dir);
  return dir;
}

/** 外部（http/https）を参照していないか */
function assertSelfContained(html) {
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']?\s*(https?:)?\/\//i);
  assert.doesNotMatch(html, /url\(\s*["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /https?:\/\//i);
}

test('rough: カットの数だけ data-cut があり、localStorage は try で囲まれている', () => {
  const dir = copySample();
  // 中身は見ないので、空のファイルを動画の代わりに置く
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out/見本_16x9_draft.mp4'), '');
  const file = buildReviewPage(dir, 'rough');
  assert.equal(file, path.join(dir, 'reviews/rough.html'));
  const html = fs.readFileSync(file, 'utf8');
  assert.equal(html.match(/data-cut="\d+"/g).length, 2);
  // localStorage を触る行は、すべて try { ... } の中にある
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  const uses = [...script.matchAll(/localStorage/g)].length;
  const guarded = [...script.matchAll(/try\s*\{[^}]*localStorage[^}]*\}/g)].length;
  assert.ok(uses > 0);
  assert.equal(guarded, uses);
  // 一時保存の鍵は制作フォルダごと
  assert.ok(html.includes(JSON.stringify(`ns-motion-studio:${path.resolve(dir)}:rough`)));
  // プレーヤーは reviews/ からの相対パスで out/ の draft を指す
  assert.match(html, /src="\.\.\/out\/%E8%A6%8B%E6%9C%AC_16x9_draft\.mp4"/);
  assert.match(html, /data-jump="1\.5"/);
  assertSelfContained(html);
});

test('関門ごとに、外部参照のない単一の HTML ができる', () => {
  const dir = copySample();
  fs.writeFileSync(path.join(dir, 'briefing.md'), '# ブリーフィング\n\n目的は **紹介**。\n\n## 不足\n\n- ロゴの SVG\n- 製品の画面\n');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/logo.png'), 'x');
  fs.mkdirSync(path.join(dir, 'reviews/style'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews/style/a-1.png'), 'x');
  fs.writeFileSync(path.join(dir, 'reviews/style/b-1.png'), 'x');
  fs.writeFileSync(path.join(dir, 'style.md'), '## 案A\n\n色は `#1F6FEB`。\n');
  for (const gate of ['briefing', 'style', 'storyboard', 'plan', 'rough', 'deliver']) {
    const html = fs.readFileSync(buildReviewPage(dir, gate), 'utf8');
    assert.match(html, /^<!doctype html>/i, gate);
    assert.match(html, /prefers-color-scheme: dark/, gate);
    assertSelfContained(html);
  }
  const brief = fs.readFileSync(path.join(dir, 'reviews/briefing.html'), 'utf8');
  assert.match(brief, /ロゴの SVG/);
  assert.match(brief, /class="card missing"/);
  assert.match(brief, /src="\.\.\/assets\/logo\.png"/);
  const style = fs.readFileSync(path.join(dir, 'reviews/style.html'), 'utf8');
  assert.match(style, /src="style\/a-1\.png"/);
  assert.match(style, /src="style\/b-1\.png"/);
  assert.match(style, /background:#1F6FEB/);
  const deliver = fs.readFileSync(path.join(dir, 'reviews/deliver.html'), 'utf8');
  assert.match(deliver, /out\/見本_16x9\.mp4 を書き出すと/);
});

test('briefing: 不足の節が「なし」だけなら、まだ届いていない素材の枠を出さない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 確認-'));
  fs.writeFileSync(path.join(dir, 'briefing.md'), '# ブリーフィング\n\n## 不足している素材\n- なし\n\n## 見た目\n明るい\n');
  const html = fs.readFileSync(buildReviewPage(dir, 'briefing'), 'utf8');
  assert.doesNotMatch(html, /class="card missing"/);
  assert.match(html, /明るい/);
});

test('briefing: 素材の見本は、白い版も黒い版も見える市松の地に置く', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 確認-'));
  const html = fs.readFileSync(buildReviewPage(dir, 'briefing'), 'utf8');
  assert.match(html, /\.asset-media\{[^}]*repeating-conic-gradient/);
});

test('storyboard: storyboard.md のカットの節と効果音を、そのカットの欄に出す', () => {
  const dir = copySample();
  fs.writeFileSync(path.join(dir, 'storyboard.md'),
    '# 絵コンテ: 見本\n\n総尺: 約 3 秒\n\n## カット1（0:00〜0:01.5）Hook\n- 画: 線が<伸びる>\n\n## カット2（0:01.5〜0:03）CTA\n- 画: 面が開く\n');
  const html = fs.readFileSync(buildReviewPage(dir, 'storyboard'), 'utf8');
  const cut = (n) => html.slice(html.indexOf(`data-cut="${n}"`), html.indexOf('</article>', html.indexOf(`data-cut="${n}"`)));
  assert.match(cut(1), /線が&lt;伸びる&gt;/);
  assert.doesNotMatch(cut(1), /面が開く/);
  assert.match(cut(2), /面が開く/);
  assert.match(cut(2), /効果音/);
  assert.match(cut(2), /pop/);
  assert.match(html, /総尺: 約 3 秒/);
});

test('briefing: 取り込んだ書体（assets/fonts/）は受け取った素材に並べない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 確認-'));
  fs.mkdirSync(path.join(dir, 'assets/fonts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/logo.svg'), '<svg/>');
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, `assets/fonts/noto-sans-jp-400-0${i}.woff2`), 'x');
  fs.writeFileSync(path.join(dir, 'assets/fonts/fonts.css'),
    "@font-face {\n  font-family: 'Noto Sans JP';\n  font-weight: 400;\n}\n@font-face {\n  font-family: 'Noto Sans JP';\n  font-weight: 700;\n}\n");
  const html = fs.readFileSync(buildReviewPage(dir, 'briefing'), 'utf8');
  assert.match(html, /受け取った素材（1件）/);
  assert.doesNotMatch(html, /woff2/);
});

test('deliver: 書体の出どころは fonts.css の記録から出し、記録が無ければ「記録なし」と出す（決めつけない）', () => {
  const dir = copySample();
  fs.mkdirSync(path.join(dir, 'assets/fonts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/fonts/fonts.css'),
    '/* ns-motion-studio: family="Noto Sans JP" source="Google Fonts" license="OFL" */\n'
    + "@font-face {\n  font-family: 'Noto Sans JP';\n  font-weight: 400;\n}\n"
    + "@font-face {\n  font-family: 'Corp Sans';\n  font-weight: 700;\n}\n");
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  const row = (fam) => html.slice(html.indexOf(fam), html.indexOf('</tr>', html.indexOf(fam)));
  assert.match(row('Noto Sans JP（400）'), /Google Fonts（OFL）/);
  assert.match(row('Corp Sans（700）'), /出どころの記録なし/);
  assert.doesNotMatch(html, /Google Fonts など/);
});

test('deliver: rights.md と compromises.md の先頭の見出しが節の見出しと同じなら、二重に出さない', () => {
  const dir = copySample();
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews/rights.md'), '# 使った素材と権利\n\n| 種類 | 素材 |\n|---|---|\n| 書体 | Inter |\n');
  fs.writeFileSync(path.join(dir, 'reviews/compromises.md'), '# 残った妥協点\n\n- カット1: 例\n');
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  assert.equal(html.split('使った素材と権利</h').length - 1, 1);
  assert.equal(html.split('残った妥協点</h').length - 1, 1);
  assert.match(html, /Inter/);
  assert.match(html, /カット1: 例/);
});

test('例外にした点検の指摘は、カットの欄に出さず、ラフ版と納品のページの「残った妥協点」に理由と並べる', () => {
  const dir = copySample();
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  const finding = { check: 'contrast', cut: 1, t: 0.5, message: 'カット1（0:00.5）: 地と文字の差が小さい', evidence: 'e', id: 'contrast|1|t01', ratio: '16:9' };
  const why = '画像で見ると、文字は帯の上にあり読める';
  for (const stage of ['build', 'final']) {
    fs.writeFileSync(path.join(dir, `reviews/checks-${stage}-16x9.json`), JSON.stringify({ ok: true, findings: [{ ...finding, waived: true, why }] }));
  }
  fs.writeFileSync(path.join(dir, 'reviews/waivers.json'), JSON.stringify([
    { key: 'contrast|1|t01|e', ratio: '16:9', check: 'contrast', cut: 1, message: finding.message, why, at: '2026-10-22T00:00:00.000Z' },
    { key: 'overlap|2|a|b|x', ratio: '16:9', check: 'overlap', cut: 2, message: 'カット2（0:01.6）: 重なり', why: '前の理由', at: '2026-10-22T00:00:00.000Z' },
  ]));
  for (const gate of ['rough', 'deliver']) {
    const html = fs.readFileSync(buildReviewPage(dir, gate), 'utf8');
    const cut1 = html.slice(html.indexOf('data-cut="1"'), html.indexOf('</article>', html.indexOf('data-cut="1"')));
    assert.doesNotMatch(cut1, /地と文字の差が小さい/, gate);
    const card = html.slice(html.indexOf('残った妥協点</h2>'));
    assert.match(card, /点検で例外にしたもの/, gate);
    assert.match(card, /地と文字の差が小さい/, gate);
    assert.match(card, /画像で見ると、文字は帯の上にあり読める/, gate);
    // 例外にしたあとで直したなど、今の点検の結果に出ていない例外も、理由と並べたうえで、当てはまらないことを添える
    assert.match(card, /重なり[\s\S]*前の理由[\s\S]*いまの点検では出ていません/, gate);
  }
  // 例外も妥協点も無ければ、ラフ版には妥協点の欄を出さない
  const plain = copySample();
  assert.doesNotMatch(fs.readFileSync(buildReviewPage(plain, 'rough'), 'utf8'), /残った妥協点/);
});

test('ratios に W:H の形でない値があっても、flex:NaN を出さない', () => {
  const dir = copySample();
  const tlFile = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl.ratios = ['16:9', 'square'];
  fs.writeFileSync(tlFile, JSON.stringify(tl));
  for (const gate of ['storyboard', 'rough']) {
    const html = fs.readFileSync(buildReviewPage(dir, gate), 'utf8');
    assert.doesNotMatch(html, /NaN/, gate);
  }
});

test('比率が複数なら、カットごとにどの比率の静止画も出し、点検の結果も比率ごとに出す', () => {
  const dir = copySample();
  const tlFile = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl.ratios = ['16:9', '9:16'];
  fs.writeFileSync(tlFile, JSON.stringify(tl));
  for (const r of ['16x9', '9x16']) {
    fs.mkdirSync(path.join(dir, 'reviews/frames', r), { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviews/frames', r, 't-0000.75.png'), 'x');
  }
  fs.writeFileSync(path.join(dir, 'reviews/checks-build-9x16.json'),
    JSON.stringify({ ok: false, findings: [{ check: 'overlap', cut: 1, t: 0.5, message: '縦の重なり' }] }));
  const sb = fs.readFileSync(buildReviewPage(dir, 'storyboard'), 'utf8');
  const cut1 = sb.slice(sb.indexOf('data-cut="1"'), sb.indexOf('</article>', sb.indexOf('data-cut="1"')));
  assert.match(cut1, /frames\/16x9\/t-0000\.75\.png/);
  assert.match(cut1, /frames\/9x16\/t-0000\.75\.png/);
  assert.match(cut1, /<figcaption>9:16<\/figcaption>/);
  const rough = fs.readFileSync(buildReviewPage(dir, 'rough'), 'utf8');
  assert.match(rough, /9:16: 縦の重なり/);
  // プレーヤーは高さがそろうよう、縦横比で幅を分ける（縦長が大きく、横長が小さくならない）
  assert.match(rough, /class="player" style="--ar:16\/9;flex:1\.77\d* 1 0"/);
  assert.match(rough, /class="player" style="--ar:9\/16;flex:0\.5625 1 0"/);
});

test('代表スチルは、カットの落ち着いた時刻（frames.mjs beats が撮る時刻）にいちばん近いコマ。コンタクトシートは分けた枚数だけ順に出す', () => {
  const dir = copySample();
  const frames = path.join(dir, 'reviews/frames/16x9');
  fs.mkdirSync(frames, { recursive: true });
  // s01（0〜1.5）の中央は 0.75、落ち着いた時刻は 1.05
  for (const t of ['0000.75', '0001.05']) fs.writeFileSync(path.join(frames, `t-${t}.png`), 'x');
  for (const n of ['02', '01']) fs.writeFileSync(path.join(dir, `reviews/contact-16x9-${n}.png`), 'x');
  const sb = fs.readFileSync(buildReviewPage(dir, 'storyboard'), 'utf8');
  const cut1 = sb.slice(sb.indexOf('data-cut="1"'), sb.indexOf('</article>', sb.indexOf('data-cut="1"')));
  assert.match(cut1, /frames\/16x9\/t-0001\.05\.png/);
  const rough = fs.readFileSync(buildReviewPage(dir, 'rough'), 'utf8');
  assert.deepEqual([...rough.matchAll(/src="(contact-[^"]+)"/g)].map((m) => m[1]), ['contact-16x9-01.png', 'contact-16x9-02.png']);
});

test('ナレーションと同じ文の字幕は、テロップに二重に並べず、ナレーションの行に「字幕も同文」と時刻を添える', () => {
  const dir = copySample();
  const tlFile = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl.narration = [{ id: 'n01', scene: 's01', text: '始めましょう。', start: 0.2, audio: null, duration: null }];
  // 空白の違いは同じ文とみなす。ほかのカットの同じ文や、字幕でない文字はテロップに残す
  tl.texts.push({ id: 't03', scene: 's01', kind: 'subtitle', text: '始め ましょう。', start: 0.2, end: 1.4 });
  tl.texts.push({ id: 't04', scene: 's02', kind: 'subtitle', text: '始めましょう。', start: 1.6, end: 2.9 });
  fs.writeFileSync(tlFile, JSON.stringify(tl));
  const html = fs.readFileSync(buildReviewPage(dir, 'storyboard'), 'utf8');
  const cut = (n) => html.slice(html.indexOf(`data-cut="${n}"`), html.indexOf('</article>', html.indexOf(`data-cut="${n}"`)));
  assert.equal(cut(1).match(/始め ?ましょう。/g).length, 1, cut(1));
  assert.match(cut(1), /<dt>テロップ<\/dt><dd><span class="say">ようこそ<\/span>/);
  assert.match(cut(1), /始めましょう。<\/span><span class="at">0:00\.2〜<\/span><span class="tag">字幕も同文 0:00\.2〜0:01\.4<\/span>/);
  assert.match(cut(2), /始めましょう。/);
});

test('テロップの原稿の改行は、確認ページでも改行として見える', () => {
  const dir = copySample();
  const html = fs.readFileSync(buildReviewPage(dir, 'storyboard'), 'utf8');
  assert.match(html, /\.say\{[^}]*white-space:pre-line/);
});

test('ブラウザで開くと、比率が複数のプレーヤーは低い窓でも同じ高さで並び、テロップの改行は改行で見える', async (t) => {
  if (!hasPackage(toolsDir(), 'puppeteer')) return t.skip('道具が未導入');
  const dir = copySample();
  const tlFile = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl.ratios = ['16:9', '9:16'];
  tl.texts[0].text = 'よう\nこそ';
  fs.writeFileSync(tlFile, JSON.stringify(tl));
  const browser = await loadPuppeteer().launch({ headless: 'shell' });
  try {
    const page = await browser.newPage();
    // 低い窓では、高さの上限（72vh）にかかる
    for (const [width, height] of [[1400, 900], [1400, 420], [700, 900]]) {
      await page.setViewport({ width, height });
      await page.goto(pathToFileURL(buildReviewPage(dir, 'rough')).href, { waitUntil: 'load' });
      const hs = await page.$$eval('.player .frame', (els) => els.map((e) => e.getBoundingClientRect().height));
      assert.equal(hs.length, 2);
      assert.ok(Math.abs(hs[0] - hs[1]) <= 1, `${width}×${height}: 高さ ${hs.join(' / ')}`);
      assert.ok(Math.max(...hs) <= height * 0.72 + 1, `${width}×${height}: 高さ ${hs.join(' / ')}`);
    }
    await page.goto(pathToFileURL(buildReviewPage(dir, 'storyboard')).href, { waitUntil: 'load' });
    const said = await page.$$eval('.say', (els) => els.map((e) => e.innerText));
    assert.ok(said.includes('よう\nこそ'), said.join(' | '));
  } finally {
    await browser.close();
  }
});

test('briefing: timeline.json がなくても作れる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 確認-'));
  const html = fs.readFileSync(buildReviewPage(dir, 'briefing'), 'utf8');
  assert.match(html, /briefing\.md がまだありません/);
});

test('前回の指摘と対応が冒頭に出る', () => {
  const dir = copySample();
  logFeedback(dir, [{ cut: 2, start: 1.5, end: 3, text: '文字を<大きく>' }, { cut: null, text: '全体に明るく' }], 'storyboard');
  markResolved(dir, 0, '96px にした');
  const html = fs.readFileSync(buildReviewPage(dir, 'rough'), 'utf8');
  const prev = html.indexOf('前回の指摘');
  assert.ok(prev > 0 && prev < html.indexOf('data-cut="1"'));
  assert.match(html, /文字を&lt;大きく&gt;/);
  assert.match(html, /96px にした/);
  assert.match(html, /未対応/);
});

test('timeline の文字（テロップ・目的）は逃がしてから載せる', () => {
  const dir = copySample();
  const file = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(file, 'utf8'));
  tl.texts[0].text = '<script>alert(1)</script>';
  tl.scenes[1].purpose = '<script>alert(2)</script>';
  fs.writeFileSync(file, JSON.stringify(tl));
  for (const gate of ['storyboard', 'rough']) {
    const html = fs.readFileSync(buildReviewPage(dir, gate), 'utf8');
    assert.doesNotMatch(html, /<script>alert/, gate);
    assert.match(html, /&lt;script&gt;alert\(1\)/, gate);
    assert.match(html, /&lt;script&gt;alert\(2\)/, gate);
  }
});

test('showPage: ページを初めて作ったときだけブラウザで開き、作り直したときは再読み込みを頼む', () => {
  const opened = [];
  const lines = [];
  const opts = { open: (f) => opened.push(f), log: (l) => lines.push(l) };
  showPage('/p/reviews/rough.html', false, opts);
  assert.deepEqual(opened, ['/p/reviews/rough.html']);
  showPage('/p/reviews/rough.html', true, opts);
  assert.deepEqual(opened, ['/p/reviews/rough.html'], '作り直しでも開いた');
  assert.match(lines.at(-1), /ページを作り直しました。開いているページを再読み込みしてください（閉じていれば、次のファイルを開いてください）: \/p\/reviews\/rough\.html/);
});

test('知らない関門は断る', () => {
  assert.throws(() => buildReviewPage(copySample(), 'final'), /関門/);
});

test('コピー文の形', () => {
  const text = copyText('新製品紹介', 'rough', [
    { cut: 3, start: 5, end: 8, text: 'テロップの『製品』を『サービス』に' },
    { cut: null, text: 'BGM をもう少し静かに\n特に後半' },
  ]);
  assert.equal(text, [
    '[ns-motion-studio 指摘] 新製品紹介 / rough',
    'カット3（0:05〜0:08）：テロップの『製品』を『サービス』に',
    '全体：BGM をもう少し静かに / 特に後半',
  ].join('\n'));
  assert.equal(formatClock(1.5), '0:01.5');
  assert.equal(formatClock(65), '1:05');
});

test('Markdown の文字は逃がしてから組む', () => {
  const html = renderMarkdown('# 見出し\n\n<script>x</script> と **太字**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.match(html, /<h3>見出し<\/h3>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>太字<\/strong>/);
  assert.match(html, /<td>2<\/td>/);
});

test('Markdown の字下げした箇条書きは、親の項目の中の入れ子の箇条にする', () => {
  const html = renderMarkdown('- 画:\n  - 行が入る\n  - 1. 番号\n- 次\n  1. 一\n  2. 二\n    - 深い\n- 最後\n\n本文').replace(/\n/g, '');
  assert.equal(html,
    '<ul><li>画:<ul><li>行が入る</li><li>1. 番号</li></ul></li>'
    + '<li>次<ol><li>一</li><li>二<ul><li>深い</li></ul></li></ol></li>'
    + '<li>最後</li></ul><p>本文</p>');
  // 字下げの無い箇条は今までどおり平らなまま
  assert.equal(renderMarkdown('- a\n- b').replace(/\n/g, ''), '<ul><li>a</li><li>b</li></ul>');
});

test('storyboard: 最後のカットのあとの「## 確認事項」などは、カットに巻き込まず別の欄に出す', () => {
  const dir = copySample();
  fs.writeFileSync(path.join(dir, 'storyboard.md'), [
    '# 絵コンテ', '', '## カット1（0:00〜0:01.5）Hook', '- 画: 線が伸びる', '',
    '## カット2（0:01.5〜0:03）CTA', '- 画: 面が開く', '', '## 確認事項', '- ロゴの色は青でよいか', ''].join('\n'));
  const html = fs.readFileSync(buildReviewPage(dir, 'storyboard'), 'utf8');
  const cut2 = html.slice(html.indexOf('data-cut="2"'), html.indexOf('</article>', html.indexOf('data-cut="2"')));
  assert.match(cut2, /面が開く/);
  assert.doesNotMatch(cut2, /ロゴの色は青/);
  assert.match(html, /ロゴの色は青でよいか/);
  assert.match(html, /確認事項/);
});

test('deliver: VOICEVOX の声は「VOICEVOX:キャラクター名」の表記と、スタイル・速さ・抑揚を権利の一覧に出す', () => {
  const dir = copySample();
  initProject(dir, { title: 't' });
  const p = readProject(dir);
  p.credits = ['VOICEVOX:四国めたん'];
  p.models = [{ date: '2026-10-22T00:00:00.000Z', kind: 'tts', model: 'voicevox', speaker: 2, voice: '四国めたん/ノーマル', speed: 1.1, intonation: 1.2 }];
  writeProject(dir, p);
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  const i = html.indexOf('ナレーションの声（VOICEVOX）');
  assert.ok(i >= 0, 'VOICEVOX の行がない');
  const row = html.slice(i, html.indexOf('</tr>', i));
  assert.match(row, /VOICEVOX:四国めたん/);
  assert.match(row, /ノーマル/);
  assert.match(row, /話す速さ 1\.1/);
  assert.match(row, /抑揚 1\.2/);
  assert.match(row, /利用規約/);
  // 記録に規約の場所が無い古い記録でも、使ってよいキャラクターの一覧から規約の場所と確かめた日を出す
  assert.match(row, /https:\/\/zunko\.jp\/con_ongen_kiyaku\.html/);
  assert.match(row, /\d{4}-\d{2}-\d{2} に確認/);
  assert.doesNotMatch(html, /ナレーションの声（生成）/);
});

test('deliver: 名前に「/」を含む声は character と style の別々の項目から出し、VOICEVOX の表記と条件を1行にまとめて日付も残す', () => {
  const dir = copySample();
  initProject(dir, { title: 't' });
  const p = readProject(dir);
  p.credits = ['VOICEVOX:小夜/SAYO'];
  p.models = [{ date: '2026-10-22T00:00:00.000Z', kind: 'tts', model: 'voicevox', speaker: 46, character: '小夜/SAYO', style: 'ノーマル', voice: '小夜/SAYO/ノーマル', speed: 1, intonation: 1 }];
  writeProject(dir, p);
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  assert.match(html, /VOICEVOX:小夜\/SAYO（ノーマル）/);
  assert.doesNotMatch(html, /クレジット表記/);
  assert.match(html, /2026-10-22/);
});

test('deliver: 古い記録（voice に「名前/スタイル」だけ）でも VOICEVOX の行を1行で出す', () => {
  const dir = copySample();
  initProject(dir, { title: 't' });
  const p = readProject(dir);
  p.credits = ['VOICEVOX:四国めたん'];
  p.models = [{ date: '2026-10-22T00:00:00.000Z', kind: 'tts', model: 'voicevox', speaker: 2, voice: '四国めたん/ノーマル', speed: 1, intonation: 1 }];
  writeProject(dir, p);
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  assert.match(html, /VOICEVOX:四国めたん（ノーマル）/);
  assert.doesNotMatch(html, /クレジット表記/);
});

test('コピーした指摘は、作り直したページ（新しい版）では欄に戻さない。コピーしていない書きかけは戻す。別の制作フォルダとは混ざらない', async (t) => {
  if (!hasPackage(toolsDir(), 'puppeteer')) return t.skip('道具が未導入');
  const dir = copySample();
  const other = copySample(); // 同じ題名の別の制作フォルダ
  const browser = await loadPuppeteer().launch({ headless: 'shell' });
  try {
    const page = await browser.newPage();
    const open = async (d) => page.goto(pathToFileURL(buildReviewPage(d, 'rough')).href, { waitUntil: 'load' });
    const value = (key) => page.$eval(`textarea[data-key="${key}"]`, (e) => e.value);
    await open(dir);
    await page.type('textarea[data-key="1"]', 'もう少しゆっくり');
    await page.click('#copy');
    // 同じ版を読み込み直しただけなら、コピーした内容も見える
    await page.reload({ waitUntil: 'load' });
    assert.equal(await value('1'), 'もう少しゆっくり');
    // コピーしていない書きかけ
    await page.type('textarea[data-key="2"]', 'まだ送っていない');
    // 作り直したページでは、コピーした指摘は欄に戻らず、書きかけは戻る
    await open(dir);
    assert.equal(await value('1'), '');
    assert.equal(await value('2'), 'まだ送っていない');
    assert.match(await page.$eval('#status', (e) => e.textContent), /前回の指摘と対応/);
    // 同じ題名でも、別の制作フォルダのページには出ない
    await open(other);
    assert.equal(await value('2'), '');
  } finally {
    await browser.close();
  }
});

// ---- ブリーフィングの名前・構成の確認・コース・既定から外していること ----

/** 見本の制作フォルダに project.json を置く（settings は上書きしたい値だけ） */
function withProject(dir, { settings = {}, gates = {} } = {}) {
  initProject(dir, { title: '見本' });
  const p = readProject(dir);
  Object.assign(p.settings, settings);
  p.gates = gates;
  writeProject(dir, p);
  return dir;
}

test('briefing のページは briefing.md を読み、brief の名前でも作れる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 確認-'));
  fs.writeFileSync(path.join(dir, 'briefing.md'), '# ブリーフィング: 題\n\n## 目的\n知ってもらう\n\n## 不足している素材\n- ロゴ\n');
  const file = buildReviewPage(dir, 'brief');
  assert.equal(path.basename(file), 'briefing.html');
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /関門1　ブリーフィングの確認/);
  assert.match(html, /知ってもらう/);
  assert.doesNotMatch(html, /ブリーフ(?!ィング)/);
});

test('brief.md しか無い初版の制作フォルダでも、要件のまとめが出る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 確認-'));
  fs.writeFileSync(path.join(dir, 'brief.md'), '# 題\n\n## 目的\n初版の目的\n');
  const html = fs.readFileSync(buildReviewPage(dir, 'briefing'), 'utf8');
  assert.match(html, /初版の目的/);
});

test('plan のページは、ブリーフィング・スタイル・絵コンテを1枚に出し、既定から外していることを並べる', () => {
  const dir = withProject(copySample(), { settings: { course: 'sample', intent: [{ check: 'contrast', why: '背景に薄く敷く文字', addedAt: '2026-10-22T00:00:00Z', stage: 'style' }] } });
  fs.writeFileSync(path.join(dir, 'briefing.md'), '# ブリーフィング: 見本\n\n## 目的\n知ってもらう\n');
  fs.writeFileSync(path.join(dir, 'style.md'), '# スタイル\n\n## パレット\n紺\n\n## 既定から外すこと\n- 背景に大きな文字を薄く敷く\n');
  fs.writeFileSync(path.join(dir, 'storyboard.md'), '# 絵コンテ\n\n## カット1（0:00〜0:01.5）\n- 画: 線\n');
  const html = fs.readFileSync(buildReviewPage(dir, 'plan'), 'utf8');
  for (const s of ['構成の確認', '要件のまとめ', '知ってもらう', 'カットごとの流れ', 'この動画で既定から外していること', '文字のコントラスト', '背景に薄く敷く文字', '背景に大きな文字を薄く敷く']) {
    assert.match(html, new RegExp(s), s);
  }
  assert.equal(html.match(/data-cut="\d+"/g).length, 2);
});

test('お試しの納品ページは、要件のまとめ・仮に決めたこと・既定から外していること・絵コンテと、本番で作り込む案内を出す', () => {
  const dir = withProject(copySample(), { settings: { course: 'trial', intent: [{ check: 'hold', why: '一瞬で流す', addedAt: '2026-10-22T00:00:00Z', stage: 'build' }] } });
  fs.writeFileSync(path.join(dir, 'briefing.md'), '# ブリーフィング: 見本\n\n## 目的\n知ってもらう\n\n## 仮に決めたこと\n- 比率は 16:9\n');
  fs.writeFileSync(path.join(dir, 'style.md'), '# スタイル\n\n## パレット\n紺\n');
  fs.writeFileSync(path.join(dir, 'storyboard.md'), '# 絵コンテ\n\n## カット1（0:00〜0:01.5）\n- 画: 線が伸びる\n');
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  for (const s of ['要件のまとめ', '仮に決めたこと', '比率は 16:9', 'この動画で既定から外していること', '一瞬で流す', 'カットごとの流れ', '線が伸びる', '本番用に仕上げたい']) {
    assert.match(html, new RegExp(s), s);
  }
  // お試しは「後から足した」の基準になる確認が無いので、印を付けない
  assert.doesNotMatch(html, /後から足した/);
});

test('本番の納品ページには、要件のまとめと絵コンテを重ねて出さない', () => {
  const dir = withProject(copySample(), { settings: { course: 'full' } });
  fs.writeFileSync(path.join(dir, 'briefing.md'), '# ブリーフィング: 見本\n\n## 目的\n知ってもらう\n');
  fs.writeFileSync(path.join(dir, 'storyboard.md'), '# 絵コンテ\n\n## カット1（0:00〜0:01.5）\n- 画: 線が伸びる\n');
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  assert.doesNotMatch(html, /要件のまとめ/);
  assert.doesNotMatch(html, /線が伸びる/);
  assert.doesNotMatch(html, /本番用に仕上げたい/);
  assert.doesNotMatch(html, /この動画で既定から外していること/);
});

test('点滅を外したとき、納品ページの冒頭に光過敏の注意を出す', () => {
  const dir = withProject(copySample(), { settings: { intent: [{ check: 'flash', why: 'サイバーな演出', addedAt: '2026-10-22T00:00:00Z', stage: 'style' }] } });
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  assert.match(html, /光に敏感な人/);
  assert.ok(html.indexOf('光に敏感な人') < html.indexOf('カットごとの確認'));
});

test('スタイルの承認より後に足した宣言と、後から見つけたシーンの宣言に「後から足した」を付ける', () => {
  const dir = withProject(copySample(), {
    gates: { style: { approvedAt: '2026-10-22T01:00:00Z' } },
    settings: { intent: [
      { check: 'contrast', why: '前から', addedAt: '2026-10-22T00:30:00Z', stage: 'style' },
      { check: 'hold', why: '描き直しで足した', addedAt: '2026-10-22T02:00:00Z', stage: 'build' },
    ] },
  });
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews/intent-seen.json'), JSON.stringify([{ scene: 's02', check: 'overflow', firstSeenAt: '2026-10-22T03:00:00Z' }]));
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  const item = (word) => html.slice(html.lastIndexOf('<li', html.indexOf(word)), html.indexOf('</li>', html.indexOf(word)));
  assert.doesNotMatch(item('前から'), /後から足した/);
  assert.match(item('描き直しで足した'), /後から足した/);
  assert.match(html, /カット2.*文字のはみ出し|文字のはみ出し.*カット2/s);
});

test('意図どおりの指摘は、カットの欄で不合格と分けて出す', () => {
  const dir = withProject(copySample());
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews/checks-final-16x9.json'), JSON.stringify({ stage: 'final', ratio: '16:9', ok: false, findings: [
    { check: 'contrast', cut: 1, t: 0.5, message: 'カット1（0:00.5）: 薄い文字', intended: true, intendedWhy: '背景に敷く' },
    { check: 'overflow', cut: 1, t: 0.6, message: 'カット1（0:00.6）: はみ出し' },
  ] }));
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  const cut1 = html.slice(html.indexOf('data-cut="1"'), html.indexOf('</article>', html.indexOf('data-cut="1"')));
  assert.match(cut1, /機械の点検で気づいたこと[\s\S]*はみ出し/);
  assert.match(cut1, /意図どおり[\s\S]*薄い文字/);
  const notes = cut1.slice(cut1.indexOf('機械の点検で気づいたこと'), cut1.indexOf('意図どおり'));
  assert.doesNotMatch(notes, /薄い文字/);
});

test('点滅の注意に、冒頭の注意書きを入れたかどうかを添える（style.md の「点滅の注意書き」から。無ければ未確認）', () => {
  const intent = [{ check: 'flash', why: 'サイバーな演出', addedAt: '2026-10-22T00:00:00Z', stage: 'style' }];
  const dir = withProject(copySample(), { settings: { intent } });
  let html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  assert.match(html, /冒頭の注意書きを入れたかは、まだ確かめていません/);
  fs.writeFileSync(path.join(dir, 'style.md'), '# スタイル\n\n## 既定から外すこと\n- 点滅を使う\n- 点滅の注意書き: 入れる\n');
  html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  assert.match(html, /冒頭に注意書きを入れています/);
  fs.writeFileSync(path.join(dir, 'style.md'), '# スタイル\n\n## 既定から外すこと\n- 点滅の注意書き：入れない\n');
  html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  assert.match(html, /冒頭に注意書きは入れていません/);
});

test('シーンの宣言の「後から足した」は、最初の点検で見つけたものには付けず、その後で増えたものにだけ付ける', () => {
  const dir = withProject(copySample(), { gates: { style: { approvedAt: '2026-10-22T01:00:00Z' } } });
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews/intent-seen.json'), JSON.stringify([
    { scene: 's01', check: 'contrast', firstSeenAt: '2026-10-22T03:00:00Z' },
    { scene: 's02', check: 'overflow', firstSeenAt: '2026-10-22T05:00:00Z' },
  ]));
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  const item = (word) => html.slice(html.lastIndexOf('<li', html.indexOf(word)), html.indexOf('</li>', html.indexOf(word)));
  assert.doesNotMatch(item('文字のコントラスト'), /後から足した/);
  assert.match(item('文字のはみ出し'), /後から足した/);
});

test('構成の確認と納品のページでは、スタイルの「案にする」ボタンを出さず、「既定から外すこと」を2回出さない', () => {
  const dir = withProject(copySample(), { settings: { course: 'sample', intent: [{ check: 'contrast', why: '薄く敷く', addedAt: '2026-10-22T00:00:00Z', stage: 'style' }] } });
  fs.mkdirSync(path.join(dir, 'reviews/style'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews/style/a-1.png'), 'x');
  fs.writeFileSync(path.join(dir, 'style.md'), '# スタイル\n\n## パレット\n紺\n\n## 既定から外すこと\n- 背景に社名を薄く敷く\n');
  for (const gate of ['plan', 'deliver']) {
    const html = fs.readFileSync(buildReviewPage(dir, gate), 'utf8');
    assert.doesNotMatch(html, /案 A にする/, gate);
    assert.equal(html.split('背景に社名を薄く敷く').length - 1, 1, gate);
  }
  // スタイルの選択のページでは、これまでどおり選べる
  assert.match(fs.readFileSync(buildReviewPage(dir, 'style'), 'utf8'), /案 A にする/);
});

test('点滅を --waive で例外にしたときも、納品ページに光過敏の注意を出す', () => {
  const dir = withProject(copySample());
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews/waivers.json'), JSON.stringify([{ key: 'k', ratio: '16:9', check: 'flash', cut: 1, message: '点滅', why: '短い', at: 'x' }]));
  assert.match(fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8'), /光に敏感な人/);
});
