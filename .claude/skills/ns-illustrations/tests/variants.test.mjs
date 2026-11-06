// 挿絵の左向き・表情違いを元の絵から書き出す処理（scripts/variants.mjs）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openLibrary } from '../scripts/library.mjs';
import { SHARED_DIR } from '../scripts/paths.mjs';
import { deriveVariants, mirrorSvg, planVariants, sourceOf, swapFace } from '../scripts/variants.mjs';

const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 760" width="400" height="760"><defs>${defs}</defs>${body}</svg>`;

describe('mirrorSvg', () => {
  it('id と url(#…) の接頭辞だけを付け替える', () => {
    const out = mirrorSvg(svg('<g data-part="a-side-right" clip-path="url(#a-side-right-clip1)"/>', '<clipPath id="a-side-right-clip1"/><linearGradient id="a-side-right-soft" x1="0" y1="0" x2="1" y2="1"/>'), 'a-side-right', 'a-side-left');
    assert.ok(out.includes('id="a-side-left-clip1"'));
    assert.ok(out.includes('url(#a-side-left-clip1)'));
    assert.ok(out.includes('id="a-side-left-soft"'));
    assert.ok(out.includes('data-part="a-side-right"'));
  });

  it('defs の後ろを反転の g で包む', () => {
    assert.equal(mirrorSvg(svg('<g data-part="x"></g>'), 'a', 'b'), svg('<g transform="translate(400,0) scale(-1,1)"><g data-part="x"></g></g>'));
  });

  it('グラデーションの向きを入れ替える', () => {
    const out = mirrorSvg(svg('', '<linearGradient id="a-s" x1="0" y1="0" x2="1" y2="1"/><linearGradient id="a-t" x1="1" y1="0" x2="0" y2="1"/>'), 'a', 'b');
    assert.ok(out.includes('<linearGradient id="b-s" x1="1" y1="0" x2="0" y2="1"/>'));
    assert.ok(out.includes('<linearGradient id="b-t" x1="0" y1="0" x2="1" y2="1"/>'));
  });

  it('path の translate の x の符号を、書き方を保って反転する', () => {
    const out = mirrorSvg(svg('<path d="M0,0" transform="translate(-9.0,-6)"/><path d="M1,1" transform="translate(2.5,7)"/><path d="M2,2" transform="translate(0,-4)"/><g transform="translate(-15,0)"></g>'), 'a', 'b');
    assert.ok(out.includes('transform="translate(9.0,-6)"'));
    assert.ok(out.includes('transform="translate(-2.5,7)"'));
    assert.ok(out.includes('transform="translate(0,-4)"'));
    assert.ok(out.includes('<g transform="translate(-15,0)">'));
  });

  it('data-mirror="keep" の要素は反転し直し、足した translate は符号を変えない', () => {
    assert.ok(mirrorSvg(svg('<path data-mirror="keep" d="M1,1"/>'), 'a', 'b').includes('<path data-mirror="keep" transform="translate(400,0) scale(-1,1)" d="M1,1"/>'));
  });

  it('末尾に改行があっても閉じた SVG を作る', () => {
    assert.equal(mirrorSvg(svg('<g></g>') + '\n', 'a', 'b').endsWith('</g></g></svg>'), true);
  });

  it('読めない書き方の影・グラデーションはエラー（黙って反転し損ねない）', () => {
    assert.throws(() => mirrorSvg(svg('<path d="M0,0" transform="translate(-9 -6)"/>'), 'a-side-right', 'b'), /a-side-right/);
    assert.throws(() => mirrorSvg(svg('', '<linearGradient id="a-s" x2="1" x1="0" y1="0" y2="1"/>'), 'a-side-right', 'b'), /a-side-right/);
  });

  it('transform を持つ要素の data-mirror="keep" はエラー', () => {
    assert.throws(() => mirrorSvg(svg('<path data-mirror="keep" transform="translate(1,1)" d="M1,1"/>'), 'a-side-right', 'b'), /a-side-right/);
  });
});

describe('swapFace', () => {
  const face = (inner) => `<g data-part="face">${inner}</g>`;
  it('入れ子を含む顔を丸ごと差し替え、顔の外は body のまま', () => {
    const body = svg(`<g data-part="head"><path id="n-clip1" d="B"/>${face('<g data-part="eyes"><path d="E1"/></g><path data-part="mouth" d="M1"/>')}</g>`);
    const src = svg(`<g data-part="head"><path d="X"/>${face('<g data-part="eyes"><g><path d="E2"/></g></g><path data-part="mouth" d="M2"/>')}</g>`);
    assert.equal(swapFace(body, 'n', src, 's'), svg(`<g data-part="head"><path id="s-clip1" d="B"/>${face('<g data-part="eyes"><g><path d="E2"/></g></g><path data-part="mouth" d="M2"/>')}</g>`));
  });

  it('どちらかに顔が無ければエラー', () => {
    assert.throws(() => swapFace(svg('<g/>'), 'n', svg(face('')), 's'), /n.*s|s.*n/);
    assert.throws(() => swapFace(svg(face('')), 'n', svg('<g/>'), 's'), /n.*s|s.*n/);
  });

  it('顔が url(#…) を持てばエラー', () => {
    assert.throws(() => swapFace(svg(face('')), 'n', svg(face('<g clip-path="url(#x-clip1)"/>')), 's'));
  });
});

describe('sourceOf', () => {
  it('直すファイルの名前を .svg 付きで並べる', () => {
    assert.equal(sourceOf({ name: 'l', kind: 'mirror', from: 'r' }), 'r.svg');
    assert.equal(sourceOf({ name: 's', kind: 'face', body: 'n', face: 's' }), 'n.svg（体）・s.svg（顔）');
    assert.equal(sourceOf({ name: 'x', kind: 'face', body: 'n', face: 's' }), 'n.svg（体）・s.svg（顔）');
  });
});

describe('planVariants', () => {
  it('右向きの素材すべてに左向きを作る', () => {
    assert.deepEqual(planVariants(['obj-x-side-right']), [{ name: 'obj-x-side-left', kind: 'mirror', from: 'obj-x-side-right' }]);
  });

  it('立ちポーズの表情は顔の元が自分自身', () => {
    assert.deepEqual(planVariants(['char-pm-stand-normal', 'char-pm-stand-smile']), [{ name: 'char-pm-stand-smile', kind: 'face', body: 'char-pm-stand-normal', face: 'char-pm-stand-smile' }]);
  });

  it('ほかのポーズの表情は立ちポーズから顔を取る', () => {
    assert.deepEqual(
      planVariants(['char-pm-xr-normal', 'char-pm-xr-smile', 'char-pm-stand-smile']).filter((p) => p.name === 'char-pm-xr-smile'),
      [{ name: 'char-pm-xr-smile', kind: 'face', body: 'char-pm-xr-normal', face: 'char-pm-stand-smile' }],
    );
  });

  it('表情を先に、反転を後に並べる', () => {
    const plan = planVariants(['char-pm-stand-side-right-smile', 'char-pm-stand-side-right-normal']);
    assert.equal(plan.length, 3);
    assert.deepEqual(plan[0], { name: 'char-pm-stand-side-right-smile', kind: 'face', body: 'char-pm-stand-side-right-normal', face: 'char-pm-stand-side-right-smile' });
    assert.equal(plan.slice(1).every((p) => p.kind === 'mirror'), true);
    assert.ok(plan.some((p) => p.name === 'char-pm-stand-side-left-smile' && p.kind === 'mirror' && p.from === 'char-pm-stand-side-right-smile'));
  });

  it('普通の顔の版が無いポーズは派生にしない', () => {
    assert.deepEqual(planVariants(['char-pm-point-smile']), []);
  });

  it('立ちポーズに無い表情を足すと止まる', () => {
    assert.throws(() => planVariants(['char-pm-xr-normal', 'char-pm-xr-confused']), /char-pm-xr-confused\.svg[\s\S]*char-pm-stand-confused\.svg[\s\S]*先に立ちポーズ/);
  });

  it('右向きの無い左向きは止まる', () => {
    assert.throws(() => planVariants(['obj-x-side-left']), /obj-x-side-left\.svg[\s\S]*obj-x-side-right\.svg/);
  });

  // 件数は大量に消えていないかだけを見る下限（素材を足しても落ちない。派生の中身は「派生ファイルが元の絵から書き出した結果と一致する」が捕まえる）
  it('今の素材では左向き 89 以上・表情違い 55 以上', () => {
    const plan = planVariants(fs.readdirSync(SHARED_DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)));
    const mirrors = plan.filter((p) => p.kind === 'mirror').length;
    const faces = plan.filter((p) => p.kind === 'face').length;
    assert.ok(mirrors >= 89, `左向きが 89 点より少なくなりました（${mirrors} 点）`);
    assert.ok(faces >= 55, `表情違いが 55 点より少なくなりました（${faces} 点）`);
  });
});

it('派生ファイルが元の絵から書き出した結果と一致する', () => {
  const names = fs.readdirSync(SHARED_DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4));
  const plans = new Map(planVariants(names).map((p) => [p.name, p]));
  const stale = [...deriveVariants(openLibrary({ shared: SHARED_DIR, personal: null }))]
    .filter(([name, svg]) => !fs.existsSync(path.join(SHARED_DIR, name + '.svg')) || fs.readFileSync(path.join(SHARED_DIR, name + '.svg'), 'utf8') !== svg)
    .map(([name]) => `${name}.svg（元の絵: ${sourceOf(plans.get(name))}）`);
  assert.deepEqual(stale, [], '派生ファイルは手で直さず、元の絵を直して node plugins/ns-illustrations/scripts/register.mjs --shared を実行してください');
});
