// スライド HTML の挿絵の印を素材で埋める処理（scripts/fill.mjs）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { assetLoaderFrom, fillIllustrations, listTargets } from '../scripts/fill.mjs';
import { SHARED_DIR } from '../scripts/paths.mjs';

const ASSETS = {
  'obj-a': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 760" width="400" height="760"><defs><clipPath id="obj-a-clip1"/></defs><g data-part="shadow"><ellipse cx="200" cy="732"/></g><g data-part="body"><g data-part="arm"><path d="M1"/></g></g><circle data-part="led" r="2"/></svg>\n',
  'ui-screen': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 740" width="360" height="740"><text data-part="title">画面</text></svg>',
};
const load = (name) => (ASSETS[name] === undefined ? undefined : { svg: ASSETS[name], origin: 'shared' });
const fill = (html) => fillIllustrations(html, load);
const INNER_A = '<defs><clipPath id="obj-a-clip1"/></defs><g data-part="shadow"><ellipse cx="200" cy="732"/></g><g data-part="body"><g data-part="arm"><path d="M1"/></g></g><circle data-part="led" r="2"/>';
const head = (html) => html.split('>')[0];

describe('fillIllustrations: 置き換え', () => {
  it('空の印の中身を、素材の外側の <svg> を外した中身で埋め、viewBox を素材の値にする', () => {
    const r = fill('<p>前</p><svg data-illust="obj-a"></svg><p>後</p>');
    assert.deepEqual(r.errors, []);
    assert.equal(r.count, 1);
    assert.equal(r.html, `<p>前</p><svg data-illust="obj-a" viewBox="0 0 400 760">${INNER_A}</svg><p>後</p>`);
    assert.deepEqual(r.used, [{ name: 'obj-a', origin: 'shared' }]);
  });

  it('既にある中身（作者が書いた入れ子の <svg> を含む）を対応する終了タグまで置き換える', () => {
    const r = fill('<svg data-illust="obj-a" viewBox="0 0 1 1"><svg><svg/><rect/></svg>古い</svg><svg id="next"></svg>');
    assert.equal(r.html, `<svg data-illust="obj-a" viewBox="0 0 400 760">${INNER_A}</svg><svg id="next"></svg>`);
  });

  it('自己終了の印も埋める', () => {
    assert.equal(fill('<svg data-illust="obj-a"/>').html, `<svg data-illust="obj-a" viewBox="0 0 400 760">${INNER_A}</svg>`);
  });

  it('外側の <svg> の中に並べた複数の印を埋め、外側は保つ', () => {
    const html = '<svg viewBox="0 0 1200 900"><rect width="1200"/><svg data-illust="obj-a" x="1"></svg><svg data-illust="obj-a" x="2"></svg></svg>';
    const r = fill(html);
    assert.equal(r.count, 2);
    assert.equal(r.html, `<svg viewBox="0 0 1200 900"><rect width="1200"/><svg data-illust="obj-a" x="1" viewBox="0 0 400 760">${INNER_A}</svg><svg data-illust="obj-a" x="2" viewBox="0 0 400 760">${INNER_A}</svg></svg>`);
  });

  it('印の他の属性を保つ', () => {
    const r = fill('<svg class="ico" data-illust="obj-a" data-name="user" x="90" y="27" role="img" aria-label="新人" data-df-cue="user" overflow="visible"></svg>');
    assert.ok(r.html.startsWith('<svg class="ico" data-illust="obj-a" data-name="user" x="90" y="27" role="img" aria-label="新人" data-df-cue="user" overflow="visible" viewBox="0 0 400 760">'));
  });

  it('印の無い HTML はそのまま', () => {
    const html = '<svg viewBox="0 0 10 10"><rect/></svg>';
    assert.deepEqual(fill(html), { html, count: 0, errors: [], used: [] });
  });

  it('何度実行しても同じ結果になる', () => {
    const html = '<svg data-illust="obj-a" data-scale="1.1" data-drop="shadow" data-viewbox="0 0 400 380"></svg><svg data-illust="ui-screen"></svg>';
    const first = fill(html);
    assert.deepEqual(fill(first.html), { html: first.html, count: 2, errors: [], used: first.used });
  });

  it('素材を描き直したら、埋め直すと追従する', () => {
    const once = fill('<svg data-illust="obj-a"></svg>').html;
    const r = fillIllustrations(once, () => ({ svg: '<svg viewBox="0 0 10 20"><path d="new"/></svg>', origin: 'shared' }));
    assert.equal(r.html, '<svg data-illust="obj-a" viewBox="0 0 10 20"><path d="new"/></svg>');
  });
});

describe('fillIllustrations: 属性', () => {
  it('data-viewbox があれば viewBox はそちら', () => {
    assert.ok(fill('<svg data-illust="obj-a" data-viewbox="0 0 400 380"></svg>').html.includes(' viewBox="0 0 400 380"'));
  });

  it('data-scale があれば width・height を viewBox の大きさ × 倍率で簡潔に書く', () => {
    assert.equal(head(fill('<svg data-illust="obj-a" data-scale="1.1"></svg>').html), '<svg data-illust="obj-a" data-scale="1.1" viewBox="0 0 400 760" width="440" height="836"');
    // 既にある値は差し替える。data-viewbox の大きさを使う
    assert.equal(head(fill('<svg data-illust="obj-a" width="1" height="2" data-scale="0.5" data-viewbox="0 0 400 381"></svg>').html), '<svg data-illust="obj-a" width="200" height="190.5" data-scale="0.5" data-viewbox="0 0 400 381" viewBox="0 0 400 381"');
  });

  it('data-scale が無ければ width・height を書かず、作者の値にも触れない', () => {
    assert.doesNotMatch(fill('<svg data-illust="obj-a"></svg>').html, /\s(width|height)="[^"]*"[^<]*><defs>/);
    assert.equal(head(fill('<svg data-illust="obj-a" width="473" height="900"></svg>').html), '<svg data-illust="obj-a" width="473" height="900" viewBox="0 0 400 760"');
  });

  it('data-drop の部品を取り除く（<g> は対応する終了タグまで、単独要素はその要素）', () => {
    const html = fill('<svg data-illust="obj-a" data-drop="shadow  led"></svg>').html;
    assert.equal(html, '<svg data-illust="obj-a" data-drop="shadow  led" viewBox="0 0 400 760"><defs><clipPath id="obj-a-clip1"/></defs><g data-part="body"><g data-part="arm"><path d="M1"/></g></g></svg>');
  });

  it('入れ子を持つ部品も丸ごと取り除く', () => {
    assert.ok(!fill('<svg data-illust="obj-a" data-drop="body"></svg>').html.includes('arm'));
  });

  it('ui-* の素材には data-check-ignore="small-text contrast" を付け、既にあれば変えない', () => {
    assert.equal(head(fill('<svg data-illust="ui-screen"></svg>').html), '<svg data-illust="ui-screen" viewBox="0 0 360 740" data-check-ignore="small-text contrast"');
    assert.equal(head(fill('<svg data-illust="ui-screen" data-check-ignore="contrast"></svg>').html), '<svg data-illust="ui-screen" data-check-ignore="contrast" viewBox="0 0 360 740"');
    assert.ok(!fill('<svg data-illust="obj-a"></svg>').html.includes('data-check-ignore'));
  });
});

describe('fillIllustrations: 属性の読み書きの頑健さ', () => {
  it('属性名の大文字小文字を区別せず、既存の属性を正しい綴りで置き換える（二重にしない）', () => {
    const tag = head(fill('<svg data-illust="ui-screen" viewbox="0 0 1 1" WIDTH="1" Height="2" data-scale="2" DATA-CHECK-IGNORE="contrast"></svg>').html);
    assert.equal(tag, '<svg data-illust="ui-screen" viewBox="0 0 360 740" width="720" height="1480" data-scale="2" DATA-CHECK-IGNORE="contrast"');
  });

  it('印の属性名が大文字でも印として読む', () => {
    assert.equal(
      fill('<svg DATA-ILLUST="obj-a" Data-Drop="shadow"></svg>').html,
      `<svg DATA-ILLUST="obj-a" Data-Drop="shadow" viewBox="0 0 400 760">${INNER_A.replace('<g data-part="shadow"><ellipse cx="200" cy="732"/></g>', '')}</svg>`,
    );
  });

  it('値に > を含む属性があっても開始タグを正しく切り出す', () => {
    const r = fill('<svg aria-label="A>B" data-illust="obj-a" data-name=\'x>y\'></svg>');
    assert.deepEqual(r.errors, []);
    assert.equal(r.html, `<svg aria-label="A>B" data-illust="obj-a" data-name='x>y' viewBox="0 0 400 760">${INNER_A}</svg>`);
  });

  it('値の中に属性に似た文字列があっても、それを属性と取り違えない', () => {
    const r = fill('<svg aria-label=" viewBox=\'9 9 9 9\' data-scale=\'3\'" data-illust="obj-a"></svg>');
    assert.equal(r.html.split('><defs>')[0], '<svg aria-label=" viewBox=\'9 9 9 9\' data-scale=\'3\'" data-illust="obj-a" viewBox="0 0 400 760"');
  });

  it('作者の入れ子の <svg> の値に > があっても対応する終了タグを探せる', () => {
    assert.equal(fill('<svg data-illust="obj-a"><svg aria-label="a>b"></svg></svg><p>後</p>').html, `<svg data-illust="obj-a" viewBox="0 0 400 760">${INNER_A}</svg><p>後</p>`);
  });

  it('data-scale を後から消しても、以前に書いた width・height は作者の値として残す（仕様どおり）', () => {
    const once = fill('<svg data-illust="obj-a" data-scale="2"></svg>').html;
    assert.equal(head(fill(once.replace(' data-scale="2"', '')).html), '<svg data-illust="obj-a" viewBox="0 0 400 760" width="800" height="1520"');
  });
});

describe('fillIllustrations: エラーでは書き換えない', () => {
  const ok = '<svg data-illust="obj-a"></svg>';

  it('素材が無い名前', () => {
    const html = `${ok}\n<svg data-illust="obj-none"></svg>`;
    const r = fill(html);
    assert.equal(r.html, html);
    assert.equal(r.count, 0);
    assert.deepEqual(r.used, []);
    assert.deepEqual(r.errors, ['2 行目の印「obj-none」: 素材「obj-none」がありません']);
  });

  it('素材名に使えない文字（フォルダの外を指す名前）は読みに行かない', () => {
    const asked = [];
    const r = fillIllustrations('<svg data-illust="../x"></svg>', (n) => { asked.push(n); return undefined; });
    assert.deepEqual(asked, []);
    assert.ok(r.errors[0].includes('../x'));
  });

  it('対応する終了タグが無い印', () => {
    const html = `${ok}<svg data-illust="obj-a"><svg></svg>`;
    const r = fill(html);
    assert.equal(r.html, html);
    assert.equal(r.count, 0);
    assert.match(r.errors[0], /obj-a.*<\/svg>/);
  });

  it('data-drop の部品が素材に無い', () => {
    const html = `${ok}<svg data-illust="obj-a" data-drop="shadow nose"></svg>`;
    const r = fill(html);
    assert.equal(r.html, html);
    assert.equal(r.count, 0);
    assert.ok(r.errors[0].includes('nose'));
  });

  it('data-scale が正の数でない', () => {
    for (const s of ['0', '-1', 'abc', '']) {
      const html = `<svg data-illust="obj-a" data-scale="${s}"></svg>`;
      const r = fill(html);
      assert.equal(r.html, html);
      assert.equal(r.count, 0);
    }
  });
});

describe('実際の素材', () => {
  it('既定の素材の置き場は共有の素材集（SHARED_DIR）', () => {
    assert.ok(fs.existsSync(path.join(SHARED_DIR, 'icon-target.svg')));
    assert.equal(path.relative(fileURLToPath(new URL('..', import.meta.url)), SHARED_DIR).split(path.sep).join('/'), 'assets/illustrations');
  });

  it('人物を倍率付きで埋め、影を取り除く', () => {
    const src = fs.readFileSync(path.join(SHARED_DIR, 'char-newbie-stand-smile.svg'), 'utf8');
    const r = fillIllustrations('<svg data-illust="char-newbie-stand-smile" data-name="user" x="90" y="27" data-scale="1.1" data-drop="shadow"></svg>', assetLoaderFrom(SHARED_DIR));
    assert.deepEqual(r.errors, []);
    assert.equal(head(r.html), '<svg data-illust="char-newbie-stand-smile" data-name="user" x="90" y="27" data-scale="1.1" data-drop="shadow" viewBox="0 0 400 760" width="440" height="836"');
    assert.ok(src.includes('data-part="shadow"'));
    assert.ok(!r.html.includes('data-part="shadow"'));
    assert.ok(r.html.includes('data-part="character"'));
    assert.equal(r.html.match(/<svg\b/g).length, 1);
    assert.ok(r.html.endsWith('</g></svg>'));
    assert.deepEqual(r.used, [{ name: 'char-newbie-stand-smile', origin: 'shared' }]);
  });

  it('画面UIの素材には検査の除外を付ける', () => {
    const r = fillIllustrations('<svg data-illust="ui-mobile-app"></svg>', assetLoaderFrom(SHARED_DIR));
    assert.ok(r.html.includes('data-check-ignore="small-text contrast"'));
  });
});

describe('used: 個人の素材集を重ねた読み出し', () => {
  it('同じ名前が個人にあれば個人を使い、used に personal と出る', () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illust-fill-s-'));
    const personal = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illust-fill-p-'));
    try {
      fs.writeFileSync(path.join(shared, 'obj-a.svg'), '<svg viewBox="0 0 1 1"><path d="shared"/></svg>');
      fs.writeFileSync(path.join(shared, 'obj-b.svg'), '<svg viewBox="0 0 1 1"><path d="b"/></svg>');
      fs.writeFileSync(path.join(personal, 'obj-a.svg'), '<svg viewBox="0 0 2 2"><path d="personal"/></svg>');
      const r = fillIllustrations('<svg data-illust="obj-a"></svg><svg data-illust="obj-b"></svg><svg data-illust="obj-a"></svg>', assetLoaderFrom(shared, personal));
      assert.deepEqual(r.errors, []);
      assert.ok(r.html.includes('personal'));
      assert.ok(!r.html.includes('shared'));
      assert.deepEqual(r.used, [{ name: 'obj-a', origin: 'personal' }, { name: 'obj-b', origin: 'shared' }]);
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
      fs.rmSync(personal, { recursive: true, force: true });
    }
  });

  it('個人の素材集のフォルダが無くても共有だけで埋める', () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illust-fill-s-'));
    try {
      fs.writeFileSync(path.join(shared, 'obj-a.svg'), '<svg viewBox="0 0 1 1"><path d="shared"/></svg>');
      const r = fillIllustrations('<svg data-illust="obj-a"></svg>', assetLoaderFrom(shared, path.join(shared, 'nothing-here')));
      assert.deepEqual(r.errors, []);
      assert.deepEqual(r.used, [{ name: 'obj-a', origin: 'shared' }]);
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });
});

describe('scripts/fill.mjs の CLI', () => {
  const SCRIPT = fileURLToPath(new URL('../scripts/fill.mjs', import.meta.url));
  let tmp = '';
  let home = '';
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  const setup = () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illust-fill-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illust-home-'));
  };
  afterEach(() => {
    for (const d of [tmp, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
    tmp = home = '';
  });

  it('フォルダ直下の .html を埋め、エラーのファイルは書き換えず終了コード 1。present/ の下は見ない', () => {
    setup();
    const good = '<svg class="ico" data-illust="icon-target"></svg>';
    const bad = '<svg data-illust="icon-target"></svg><svg data-illust="obj-none"></svg>';
    fs.writeFileSync(path.join(tmp, '01-a.html'), good);
    fs.writeFileSync(path.join(tmp, '02-b.html'), bad);
    fs.mkdirSync(path.join(tmp, 'present'));
    fs.writeFileSync(path.join(tmp, 'present', 'index.html'), good);

    const r = run(tmp);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('01-a.html（印 1 個）'));
    assert.ok(r.stderr.includes('02-b.html'));
    assert.ok(r.stderr.includes('obj-none'));
    assert.match(fs.readFileSync(path.join(tmp, '01-a.html'), 'utf8'), /^<svg class="ico" data-illust="icon-target" viewBox="0 0 200 200">.+<\/svg>$/);
    assert.equal(fs.readFileSync(path.join(tmp, '02-b.html'), 'utf8'), bad);
    assert.equal(fs.readFileSync(path.join(tmp, 'present', 'index.html'), 'utf8'), good);
  });

  it('個人の素材集が無くても共有だけで埋める（初回の利用者）', () => {
    setup();
    const file = path.join(tmp, '01-a.html');
    fs.writeFileSync(file, '<svg data-illust="icon-target"></svg>');
    const r = run(file);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('個人の素材集:'));
    assert.match(fs.readFileSync(file, 'utf8'), /viewBox="0 0 200 200"/);
  });

  it('個人から取った素材は「個人の素材集: <名前>」の行で出し、個人の絵で埋める', () => {
    setup();
    const personal = path.join(home, '.claude/ns-illustrations/illustrations');
    fs.mkdirSync(personal, { recursive: true });
    fs.writeFileSync(path.join(personal, 'icon-target.svg'), '<svg viewBox="0 0 3 3"><path d="mine"/></svg>');
    const file = path.join(tmp, '01-a.html');
    fs.writeFileSync(file, '<svg data-illust="icon-target"></svg><svg data-illust="icon-target"></svg><svg data-illust="ui-mobile-app"></svg>');
    const r = run(file);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.split('\n').filter((l) => l.trim() === '個人の素材集: icon-target').length, 1);
    assert.ok(!r.stdout.includes('個人の素材集: ui-mobile-app'));
    assert.ok(fs.readFileSync(file, 'utf8').includes('d="mine"'));
  });

  it('引数が無ければ使い方を出して終了コード 1', () => {
    setup();
    const r = run();
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('使い方'));
  });

  it('シンボリックリンク（Windows はジャンクション）越しに起動しても CLI として動く', () => {
    setup();
    const link = path.join(tmp, 'linked-scripts');
    fs.symlinkSync(path.dirname(SCRIPT), link, process.platform === 'win32' ? 'junction' : 'dir');
    let r;
    try {
      r = spawnSync(process.execPath, [path.join(link, 'fill.mjs')], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    } finally {
      fs.rmSync(link); // リンク自体だけを消す（先の scripts/ は辿らない）
    }
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.stderr.includes('使い方'), r.stderr);
  });

  it('--assets は廃止（知らない引数として止まる）', () => {
    setup();
    const r = run(tmp, '--assets', tmp);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('--assets'));
  });
});

describe('listTargets', () => {
  it('ファイルはそのまま、フォルダは直下の .html だけ', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illust-fill-'));
    try {
      fs.writeFileSync(path.join(dir, 'b.html'), '');
      fs.writeFileSync(path.join(dir, 'a.html'), '');
      fs.writeFileSync(path.join(dir, 'c.css'), '');
      fs.mkdirSync(path.join(dir, 'assets'));
      fs.writeFileSync(path.join(dir, 'assets', 'd.html'), '');
      assert.deepEqual(listTargets([dir, 'x.html']), [path.join(dir, 'a.html'), path.join(dir, 'b.html'), 'x.html']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
