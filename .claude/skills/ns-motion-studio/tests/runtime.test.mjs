// ブラウザ側ランタイム（ms-runtime.js）を、fixture のシーンを Puppeteer で開いて検証する
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyTree, removeTree, toolsDir } from '../scripts/paths.mjs';
import { sceneInit, sceneUrl } from '../scripts/scene-page.mjs';
import { hasPackage, loadPuppeteer } from '../scripts/tools.mjs';
import { openScene } from './helpers/open-scene.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SAMPLE = path.join(FIXTURES, 'sample');
const CASES = path.join(FIXTURES, 'runtime-cases');
const TIMELINE = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'timeline.json'), 'utf8'));
const HAS_TOOLS = hasPackage(toolsDir(), 'puppeteer');

/** @type {any} */
let browser;
before(async () => {
  if (!HAS_TOOLS) return;
  browser = await loadPuppeteer().launch({ headless: 'shell', args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
});
after(async () => {
  await browser?.close();
});

/** 道具が無ければ飛ばし、あれば本体を実行する */
function browserTest(name, fn) {
  test(name, async (t) => {
    if (!HAS_TOOLS) return t.skip('道具が未導入');
    await fn(t);
  });
}

test('sceneInit は比率の解像度と、シーン内の時刻にした slice を返す', () => {
  const init = sceneInit(SAMPLE, 's02', '9:16');
  assert.equal(init.width, 1080);
  assert.equal(init.height, 1920);
  assert.equal(init.seed, 1);
  assert.equal(init.slice.texts[0].id, 't02');
  assert.equal(init.slice.texts[0].start, 0.1);
  assert.throws(() => sceneInit(SAMPLE, 's01', '3:2'), /比率 3:2/);
  assert.match(sceneUrl(SAMPLE, 's01'), /^file:.*\/src\/scenes\/s01\.html$/);
});

browserTest('同じ時刻を2回描くと、スクリーンショットが一致する', async () => {
  const page = await openScene(browser, SAMPLE, 's01');
  await page.evaluate(() => window.__ms.ready());
  await page.evaluate(() => window.__ms.seek(1.0));
  const a = await page.screenshot({ type: 'png' });
  await page.evaluate(() => window.__ms.seek(0.3));
  const mid = await page.screenshot({ type: 'png' });
  await page.evaluate(() => window.__ms.seek(1.0));
  const b = await page.screenshot({ type: 'png' });
  assert.ok(!a.equals(mid), '別の時刻では絵が変わる');
  assert.ok(a.equals(b), '同じ時刻なら同じ画素');
  await page.close();
});

browserTest('data-ms-text には正本の文字が入り、layout() が id 付きで返す', async () => {
  const page = await openScene(browser, SAMPLE, 's01');
  await page.evaluate(() => window.__ms.ready());
  await page.evaluate(() => window.__ms.seek(1.0));
  const items = await page.evaluate(() => window.__ms.layout());
  const t01 = items.find((x) => x.id === 't01');
  assert.ok(t01, 't01 が見えている');
  assert.equal(t01.text, TIMELINE.texts.find((x) => x.id === 't01').text);
  assert.ok(t01.box.w > 0 && t01.box.h > 0);
  assert.equal(t01.color, 'rgb(255, 255, 255)');
  assert.equal(t01.fontSize, 120);
  assert.equal(t01.opacity, 1, '祖先まで掛け合わせた不透明度');
  assert.equal(await page.evaluate(() => ms.text('t01')), 'ようこそ');
  // ms.time は、そのテキストの出る時刻と消える時刻をシーン内の秒で返す（timeline.json の時刻に動きを合わせるため）
  assert.deepEqual(await page.evaluate(() => ms.time('t01')), { start: 0.1, end: 1.45 });
  assert.match(await page.evaluate(() => { try { ms.time('t99'); return ''; } catch (e) { return e.message; } }), /t99/);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.ratio), '16:9');
  // 見えていない時刻（表示前）は返さない
  await page.evaluate(() => window.__ms.seek(0));
  assert.equal((await page.evaluate(() => window.__ms.layout())).length, 0);
  await page.close();
});

browserTest('data-ms-text の無い直書きの文字は id: null で返り、見えない文字は返らない', async () => {
  const page = await openScene(browser, CASES, 'c01');
  await page.evaluate(() => window.__ms.ready());
  await page.evaluate(() => window.__ms.seek(0.5));
  const items = await page.evaluate(() => window.__ms.layout());
  assert.deepEqual(items.map((x) => [x.id, x.text]), [['t01', '正本の文字'], [null, '直書きの文字']]);
  await page.close();
});

browserTest('存在しないフォントを指定したシーンでは、ready() が missingFonts 付きで reject する', async () => {
  const page = await openScene(browser, CASES, 'c02');
  const r = await page.evaluate(() => window.__ms.ready().then(() => 'resolved', (e) => ({ message: e.message, missingFonts: e.missingFonts })));
  assert.deepEqual(r.missingFonts, ['NsMsNoSuchFont']);
  assert.match(r.message, /NsMsNoSuchFont/);
  await page.close();
});

browserTest('見本のシーンは ready() が解決する', async () => {
  for (const id of ['s01', 's02']) {
    const page = await openScene(browser, SAMPLE, id);
    await page.evaluate(() => window.__ms.ready());
    await page.close();
  }
});

browserTest('ひな形のシーンは、fonts.css が無い制作フォルダでもそのまま描ける', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-scene-'));
  fs.mkdirSync(path.join(dir, 'src/scenes'), { recursive: true });
  fs.copyFileSync(path.join(SAMPLE, 'timeline.json'), path.join(dir, 'timeline.json'));
  fs.copyFileSync(fileURLToPath(new URL('../templates/scene.html', import.meta.url)), path.join(dir, 'src/scenes/s01.html'));
  const page = await openScene(browser, dir, 's01', { ratio: '9:16' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.evaluate(() => window.__ms.ready());
  await page.evaluate(() => window.__ms.seek(1.0));
  const items = await page.evaluate(() => window.__ms.layout());
  assert.deepEqual(items.map((x) => [x.id, x.text, x.fontSize]), [['t01', 'ようこそ', 88]]);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('Math.random() の列は seed が同じなら一致し、seek のたびに seed から始まる', async () => {
  const draw = (p) => p.evaluate(() => Array.from({ length: 5 }, () => Math.random()));
  const p1 = await openScene(browser, SAMPLE, 's02');
  const p2 = await openScene(browser, SAMPLE, 's02');
  const p3 = await openScene(browser, SAMPLE, 's02', { seed: 2 });
  for (const p of [p1, p2, p3]) await p.evaluate(() => window.__ms.seek(0.5));
  const a = await draw(p1);
  assert.deepEqual(a, await draw(p2));
  assert.notDeepEqual(a, await draw(p3));
  assert.ok(a.every((x) => x >= 0 && x < 1));
  await p1.evaluate(() => window.__ms.seek(1.2));
  assert.deepEqual(await draw(p1), a);
  for (const p of [p1, p2, p3]) await p.close();
});

browserTest('時計と requestAnimationFrame は seek の時刻を返す', async () => {
  const page = await openScene(browser, SAMPLE, 's02');
  const r = await page.evaluate(() => {
    let raf = null;
    requestAnimationFrame((ts) => { raf = ts; });
    const d0 = Date.now();
    window.__ms.seek(1.25);
    return { raf, perf: performance.now(), dd: Date.now() - d0, newDate: new Date().getTime() - Date.now() };
  });
  assert.deepEqual(r, { raf: 1250, perf: 1250, dd: 1250, newDate: 0 });
  // new を付けない Date() は、本物と同じく今の時刻の文字列を返す
  const s = await page.evaluate(() => ({ str: Date(), expect: new Date().toString(), inst: new Date(0) instanceof Date }));
  assert.equal(s.str, s.expect);
  assert.equal(s.inst, true);
  await page.close();
});

browserTest('setTimeout / setInterval は読み込みの間だけ使え、ready() の後は draw の中で呼ぶと seek が例外になる', async () => {
  const page = await openScene(browser, SAMPLE, 's02');
  // 読み込みの間は本物のタイマー（外部の部品の初期化のため）
  assert.equal(await page.evaluate(() => new Promise((r) => setTimeout(() => r('fired'), 10))), 'fired');
  await page.evaluate(() => window.__ms.ready());
  const r = await page.evaluate(() => {
    const err = (f) => { try { f(); return null; } catch (e) { return e.message; } };
    return {
      direct: [err(() => setTimeout(() => {}, 10)), err(() => setInterval(() => {}, 10))],
      inDraw: err(() => {
        ms.scene((t) => { if (t > 0.5) setTimeout(() => {}, 100); });
        window.__ms.seek(1.0);
      }),
    };
  });
  for (const m of [...r.direct, r.inDraw]) {
    assert.equal(m, 'シーンでは setTimeout / setInterval を使えません。動きは draw(t) の中で時刻 t から決めてください。');
  }
  // 書き出しの道具からは page.evaluate の例外として受け取れる
  await assert.rejects(page.evaluate(() => window.__ms.seek(1.0)), /setTimeout \/ setInterval を使えません/);
  await page.close();
});

browserTest('撮る順序を変えても絵が同じ（トランジションは止まる）', async () => {
  const shoot = async (times) => {
    const page = await openScene(browser, CASES, 'c03');
    await page.evaluate(() => window.__ms.ready());
    for (const t of times) await page.evaluate((x) => window.__ms.seek(x), t);
    const png = await page.screenshot({ type: 'png' });
    await page.close();
    return png;
  };
  const fresh = await shoot([0.3]);
  assert.ok((await shoot([1.0, 0.3])).equals(fresh), '1.0 の後に 0.3 を撮っても、0.3 だけを撮ったのと同じ');
  assert.ok((await shoot([0.1, 1.4, 0.3])).equals(fresh));
  // 時刻を戻す方向
  assert.ok((await shoot([1.0, 0.1])).equals(await shoot([0.1])), '1.0 の後に 0.1 を撮っても、0.1 だけを撮ったのと同じ');
});

browserTest('crypto の乱数も seed から作る', async () => {
  const draw = (p) => p.evaluate(() => ({ v: Array.from(crypto.getRandomValues(new Uint32Array(4))), u: crypto.randomUUID() }));
  const p1 = await openScene(browser, SAMPLE, 's02');
  const p2 = await openScene(browser, SAMPLE, 's02');
  for (const p of [p1, p2]) await p.evaluate(() => window.__ms.seek(0.5));
  const a = await draw(p1);
  assert.deepEqual(a, await draw(p2));
  assert.match(a.u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (const p of [p1, p2]) await p.close();
});

browserTest('読み込めない画像があると、ready() が src 付きで reject する', async () => {
  const page = await openScene(browser, CASES, 'c04');
  const r = await page.evaluate(() => window.__ms.ready().then(() => 'resolved', (e) => ({ message: e.message, brokenImages: e.brokenImages })));
  assert.equal(r.brokenImages.length, 1);
  assert.match(r.brokenImages[0], /no-such-image\.png$/);
  assert.match(r.message, /no-such-image\.png/);
  await page.close();
});

/** 参照用: cubic-bezier を二分法だけで解く（ランタイムとは別の実装） */
function refBezier(x1, y1, x2, y2) {
  const bz = (a, b, u) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  return (x) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (bz(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return bz(y1, y2, (lo + hi) / 2);
  };
}

browserTest('イージングは CSS の cubic-bezier と同じ値になる', async () => {
  const CURVES = {
    outExpo: [0.16, 1, 0.3, 1],
    outQuint: [0.22, 1, 0.36, 1],
    inOutCubic: [0.76, 0, 0.24, 1],
    inQuart: [0.7, 0, 0.84, 0],
    outBack: [0.34, 1.56, 0.64, 1],
  };
  const page = await openScene(browser, SAMPLE, 's02');
  const got = await page.evaluate(() => Object.fromEntries(Object.entries(ms.ease).map(([k, f]) => [k, [0.25, 0.5, 0.75].map(f)])));
  for (const [name, pts] of Object.entries(CURVES)) {
    const ref = refBezier(...pts);
    [0.25, 0.5, 0.75].forEach((x, i) => {
      assert.ok(Math.abs(got[name][i] - ref(x)) < 1e-4, `${name}(${x}): ${got[name][i]} と ${ref(x)}`);
    });
  }
  await page.close();
});

browserTest('ばねは不正な値を断り、臨界減衰の近くでも滑らか', async () => {
  const page = await openScene(browser, SAMPLE, 's02');
  const r = await page.evaluate(() => {
    const err = (o) => { try { ms.spring(o); return null; } catch (e) { return e.message; } };
    const at = (d) => ms.spring({ damping: d, stiffness: 100 })(0.3);
    return { bad: [err({ stiffness: 0 }), err({ damping: -1 }), err({ stiffness: NaN })], near: [at(20 - 1e-9), at(20), at(20 + 1e-9)] };
  });
  for (const m of r.bad) assert.match(m, /ばね/);
  for (const v of r.near) {
    assert.ok(Number.isFinite(v));
    assert.ok(Math.abs(v - r.near[1]) < 1e-6, `臨界減衰の前後で値が飛ばない: ${r.near}`);
  }
  await page.close();
});

browserTest('イージングとばねは端の値を守る', async () => {
  const page = await openScene(browser, SAMPLE, 's02');
  const r = await page.evaluate(() => ({
    ends: Object.values(ms.ease).map((f) => [f(0), f(1)]),
    names: Object.keys(ms.ease).sort(),
    mid: ms.ease.inOutCubic(0.5),
    overshoot: Math.max(...Array.from({ length: 99 }, (_, i) => ms.ease.outBack((i + 1) / 100))),
    spring: [ms.spring({ damping: 10, stiffness: 100 })(0), ms.spring({ damping: 10, stiffness: 100 })(5)],
  }));
  assert.deepEqual(r.names, ['inOutCubic', 'inQuart', 'outBack', 'outExpo', 'outQuint']);
  for (const [a, b] of r.ends) {
    assert.ok(Math.abs(a) < 1e-6 && Math.abs(b - 1) < 1e-6);
  }
  assert.ok(Math.abs(r.mid - 0.5) < 1e-3);
  assert.ok(r.overshoot > 1);
  assert.equal(r.spring[0], 0);
  assert.ok(Math.abs(r.spring[1] - 1) < 1e-3);
  await page.close();
});

browserTest('layout() の箱は、祖先の overflow と自分や祖先の clip-path: inset() で隠れた部分を除く（全部隠れた文字は返らない）', async () => {
  const page = await openScene(browser, CASES, 'c05');
  await page.evaluate(() => window.__ms.ready());
  await page.evaluate(() => window.__ms.seek(0.5));
  const items = await page.evaluate(() => window.__ms.layout());
  const by = Object.fromEntries(items.map((x) => [x.id, x.box]));
  assert.deepEqual(Object.keys(by).sort(), ['t03', 't04', 't06'], '全部隠れた t05 は返らない');
  // t06: 子の span の切り抜きも数える。2行目（400〜500px、全部切り抜き）は箱に入らない
  assert.ok(by.t06.y + by.t06.h <= 400, JSON.stringify(by.t06));
  // t03: 文字の行は 150〜250px にあるが、外の箱が 200px で切る
  assert.ok(by.t03.y >= 150 && by.t03.y < 200, String(by.t03.y));
  assert.equal(by.t03.y + by.t03.h, 200);
  // t04: 行は 300〜400px、下の半分（350px から下）を切り抜く
  assert.ok(by.t04.y >= 300 && by.t04.y < 350, String(by.t04.y));
  assert.equal(by.t04.y + by.t04.h, 350);
  await page.close();
});

browserTest('位置を決めていない箱の overflow は、中の absolute と fixed の文字を切らない', async () => {
  const page = await openScene(browser, CASES, 'c06');
  await page.evaluate(() => window.__ms.ready());
  await page.evaluate(() => window.__ms.seek(0.5));
  const items = await page.evaluate(() => window.__ms.layout());
  const by = Object.fromEntries(items.map((x) => [x.id, x]));
  // t07 は static の箱（300×80）の中にあるが、absolute なので箱に切られず、t08 と同じ場所に見える
  assert.ok(by.t07, JSON.stringify(items.map((x) => x.id)));
  const at = ({ x, y, h }) => ({ x, y, h });
  assert.deepEqual(at(by.t07.box), at(by.t08.box));
  assert.ok(by.t07.box.x >= 600 && by.t07.box.y >= 400, JSON.stringify(by.t07.box));
  // t09 は fixed なので、static の箱に切られない
  assert.ok(by.t09, JSON.stringify(items.map((x) => x.id)));
  assert.ok(by.t09.box.y >= 700 && by.t09.box.y + by.t09.box.h > 780, JSON.stringify(by.t09.box));
  await page.close();
});

browserTest('layout() は、マスクで切る前の箱（full）も返す（画面の端や小さな箱で切れた文字を見つけるため）', async () => {
  const page = await openScene(browser, CASES, 'c06');
  await page.evaluate(() => window.__ms.ready());
  await page.evaluate(() => window.__ms.seek(0.5));
  const items = await page.evaluate(() => window.__ms.layout());
  const by = Object.fromEntries(items.map((x) => [x.id, x]));
  // t10: 舞台の箱が画面の右の端（1920px）で切るが、full は画面の外まで伸びる
  assert.equal(by.t10.box.x + by.t10.box.w, 1920);
  assert.ok(by.t10.full.x + by.t10.full.w > 1920, JSON.stringify(by.t10.full));
  // t11: 幅 200px の箱で切れる。full はそれより広い
  assert.equal(by.t11.box.w, 200);
  assert.ok(by.t11.full.w > 200, JSON.stringify(by.t11.full));
  // 切れていない文字は、box と full が同じ
  assert.deepEqual(by.t08.full, by.t08.box);
  await page.close();
});

browserTest('layout() の cut は、マスクで文字の一部が隠れているときだけ true（行の高さぴったりのマスク・data-ms-scroll の中は false、省略記号は true）', async (t) => {
  const page = await openScene(browser, CASES, 'c07');
  try {
    try {
      await page.evaluate(() => window.__ms.ready());
    } catch (e) {
      // 見出しの書体 Noto Sans JP が、この機械に無い
      if (/Noto Sans JP/.test(String(e))) return t.skip('Noto Sans JP が未導入');
      throw e;
    }
    await page.evaluate(() => window.__ms.seek(0.5));
    const items = await page.evaluate(() => window.__ms.layout());
    const by = Object.fromEntries(items.map((x) => [x.id, x]));
    // 行の高さ 1.05 の見出しは、文字ノードの箱（約 1.45em）が箱より高いが、切れてはいない
    assert.ok(by.t12.full.h > by.t12.box.h, '字面の上下の余白は箱で切られている');
    assert.equal(by.t12.cut, false);
    // data-ms-scroll の箱の中の流れる文字は、切れていても問わない（full も箱の中に収める）
    assert.equal(by.t13.cut, false);
    assert.equal(by.t14.cut, false);
    assert.deepEqual(by.t13.full, by.t13.box);
    // 省略記号で切った文字は、自分の overflow で切れている
    assert.equal(by.t15.cut, true);
    assert.equal(by.t15.box.w, 300);
  } finally {
    await page.close();
  }
});

browserTest('layout() の spill は、文字の行の箱が、いちばん近い背景つきの祖先の箱（枠線の内側）を越える幅を返す', async () => {
  const page = await openScene(browser, CASES, 'c08');
  try {
    await page.evaluate(() => window.__ms.ready());
    await page.evaluate(() => window.__ms.seek(2));
    const items = await page.evaluate(() => window.__ms.layout());
    const by = Object.fromEntries(items.map((x) => [x.id, x]));
    // t16: 幅 400px の行（背景色）から、右へ大きくはみ出す
    assert.ok(by.t16.spill.over > 100, JSON.stringify(by.t16.spill));
    assert.deepEqual(by.t16.spill.paint, { x: 100, y: 100, w: 400, h: 90 });
    // t17: 余白つきの札に収まる（越える幅は 0 以下）
    assert.ok(by.t17.spill.over <= 0, JSON.stringify(by.t17.spill));
    // t18: 飾りの丸は祖先ではなく、画面全体の body の背景は数えないので、比べる箱が無い
    assert.equal(by.t18.spill, null);
    // t21: static の札の中の absolute の文字は札の外に置かれる。札は包含ブロックではないので比べない
    assert.equal(by.t21.spill, null);
    // t20: 枠線だけの箱も背景つきの箱として数え、枠線の内側と比べる
    assert.deepEqual(by.t20.spill.paint, { x: 102, y: 752, w: 400, h: 100 });
    assert.ok(by.t20.spill.over > 100, JSON.stringify(by.t20.spill));
  } finally {
    await page.close();
  }
});

browserTest('行の高さ normal の文字は、字の大きさ（1em）の箱で比べる（字面の箱より低い札を、はみ出しや切れたままとしない）', async (t) => {
  const page = await openScene(browser, CASES, 'c09');
  try {
    try {
      await page.evaluate(() => window.__ms.ready());
    } catch (e) {
      if (/Noto Sans JP/.test(String(e))) return t.skip('Noto Sans JP が未導入');
      throw e;
    }
    await page.evaluate(() => window.__ms.seek(0.5));
    const sizes = await page.evaluate(() => [...document.querySelectorAll('.badge')].map((el) => {
      const r = document.createRange();
      r.selectNodeContents(el.firstChild);
      return { content: r.getBoundingClientRect().height, box: el.getBoundingClientRect().height };
    }));
    for (const x of sizes) assert.ok(x.content > x.box, `前提: 字面の箱 ${x.content} が札の高さ ${x.box} より高い`);
    const by = Object.fromEntries((await page.evaluate(() => window.__ms.layout())).map((x) => [x.id, x]));
    // t22: 札（背景つき）からはみ出していない
    assert.ok(by.t22.spill.over <= 0, JSON.stringify(by.t22.spill));
    // t23: overflow: hidden の札で、字面の上下の余白は切られるが、字は切れていない
    assert.equal(by.t23.cut, false);
    assert.ok(by.t23.spill.over <= 0, JSON.stringify(by.t23.spill));
  } finally {
    await page.close();
  }
});

browserTest('layout() の intent は、要素と祖先の data-ms-intent の語を合わせ、intents() はページの宣言を返す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 宣言-'));
  try {
    copyTree(SAMPLE, dir);
    const file = path.join(dir, 'src/scenes/s01.html');
    let html = fs.readFileSync(file, 'utf8').replace('<body', '<body data-ms-intent="blank"');
    html = html.replace(/(<[a-z0-9]+)([^>]*data-ms-text="t01")/, '<div data-ms-intent="contrast overflow">$1 data-ms-intent="contrast"$2');
    html = html.replace(/(data-ms-text="t01"[^>]*>[^<]*<\/[a-z0-9]+>)/, '$1</div>');
    fs.writeFileSync(file, html);
    const page = await openScene(browser, dir, 's01');
    await page.evaluate(() => window.__ms.ready());
    await page.evaluate(() => window.__ms.seek(1.0));
    const t01 = (await page.evaluate(() => window.__ms.layout())).find((x) => x.id === 't01');
    assert.deepEqual([...t01.intent].sort(), ['blank', 'contrast', 'overflow']);
    const d = await page.evaluate(() => window.__ms.intents());
    assert.deepEqual(d.root, ['blank']);
    assert.deepEqual([...d.all].sort(), ['blank', 'contrast', 'overflow']);
    await page.close();
  } finally {
    removeTree(dir);
  }
});
