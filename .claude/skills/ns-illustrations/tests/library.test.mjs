// 共有の素材集に個人の素材集を重ねた見え方（scripts/library.mjs）と、その上での派生（deriveVariants）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openLibrary } from '../scripts/library.mjs';
import { deriveVariants, redundantVariants } from '../scripts/variants.mjs';

/** 顔の部品だけを持つ人物の SVG。顔の中身で、どのファイルから取ったかを見分ける */
const charSvg = (tag) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 760" width="400" height="760"><defs></defs><g data-part="head"><g data-part="face"><path d="${tag}"/></g></g><path data-part="body" d="B-${tag}"/></svg>`;

let root = '';
let shared = '';
let personal = '';
const put = (dir, name, svg = charSvg(name)) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.svg'), svg);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illustrations-lib-'));
  shared = path.join(root, 'shared');
  personal = path.join(root, 'personal');
  fs.mkdirSync(shared);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('openLibrary', () => {
  it('個人のフォルダが無くても開ける', () => {
    put(shared, 'obj-a');
    const lib = openLibrary({ shared, personal });
    assert.deepEqual(lib.names(), ['obj-a']);
    assert.deepEqual(lib.personalNames(), []);
    assert.equal(lib.origin('obj-a'), 'shared');
  });

  it('reviews フォルダは素材に数えない', () => {
    put(personal, 'obj-b');
    put(path.join(personal, 'reviews', 'obj-b'), 'sheet');
    const lib = openLibrary({ shared, personal });
    assert.deepEqual(lib.names(), ['obj-b']);
    assert.deepEqual(lib.personalNames(), ['obj-b']);
    assert.equal(lib.read('sheet'), undefined);
  });

  it('origin は個人を優先する', () => {
    put(shared, 'obj-a', '<svg>shared</svg>');
    put(personal, 'obj-a', '<svg>personal</svg>');
    put(shared, 'obj-c');
    const lib = openLibrary({ shared, personal });
    assert.deepEqual(lib.names(), ['obj-a', 'obj-c']);
    assert.equal(lib.origin('obj-a'), 'personal');
    assert.equal(lib.read('obj-a'), '<svg>personal</svg>');
    assert.equal(lib.origin('obj-c'), 'shared');
    assert.equal(lib.origin('obj-z'), undefined);
    assert.equal(lib.read('obj-z'), undefined);
  });

  it('personal: null は共有だけを見る', () => {
    put(shared, 'obj-a');
    const lib = openLibrary({ shared, personal: null });
    assert.deepEqual(lib.names(), ['obj-a']);
    assert.deepEqual(lib.personalNames(), []);
  });
});

describe('deriveVariants（重ねた見え方）', () => {
  it('共有のロールに個人で新しいポーズを足すと、顔は共有の立ちポーズから取って個人へ派生を書く', () => {
    put(shared, 'char-x-stand-side-right-normal');
    put(shared, 'char-x-stand-side-right-smile');
    put(personal, 'char-x-point-side-right-normal');
    // 表情違いは、そのファイル名があるときに書き出す（planVariants）。体を写した置き場の版を置く
    put(personal, 'char-x-point-side-right-smile', charSvg('char-x-point-side-right-normal'));
    const out = deriveVariants(openLibrary({ shared, personal }));
    assert.deepEqual([...out.keys()].sort(), ['char-x-point-side-left-normal', 'char-x-point-side-left-smile', 'char-x-point-side-right-smile']);
    // 顔は共有の立ちポーズ、体は個人のポーズ
    assert.ok(out.get('char-x-point-side-right-smile').includes('d="char-x-stand-side-right-smile"'));
    assert.ok(out.get('char-x-point-side-right-smile').includes('d="B-char-x-point-side-right-normal"'));
    // 共有だけを元にした派生は書かない
    assert.equal(out.has('char-x-stand-side-left-normal'), false);
    assert.equal(out.has('char-x-stand-side-right-smile'), false);
  });

  it('個人で共有の立ちポーズの顔を描き直すと、その顔を使う共有のポーズの表情違いも個人へ作り直す', () => {
    put(shared, 'char-x-stand-side-right-normal');
    put(shared, 'char-x-stand-side-right-smile');
    put(shared, 'char-x-point-side-right-normal');
    put(shared, 'char-x-point-side-right-smile', charSvg('old-face'));
    put(personal, 'char-x-stand-side-right-smile', charSvg('new-face'));
    const out = deriveVariants(openLibrary({ shared, personal }));
    assert.ok(out.get('char-x-point-side-right-smile').includes('d="new-face"'));
    assert.ok(out.get('char-x-point-side-left-smile').includes('d="new-face"'));
    assert.ok(out.has('char-x-stand-side-left-smile'));
    // 個人の絵を使わない派生は書かない
    assert.equal(out.has('char-x-point-side-left-normal'), false);
    assert.equal(out.has('char-x-stand-side-left-normal'), false);
  });

  it('元がすべて共有由来の個人の派生は作り直し、共有と同じなら消す（左向きの先まで辿る）', () => {
    put(shared, 'char-x-stand-side-right-normal');
    put(shared, 'char-x-stand-side-right-smile');
    put(shared, 'char-x-point-side-right-normal');
    put(shared, 'char-x-point-side-right-smile');
    // 共有の派生を書き出しておく（共有の登録の後の状態）
    for (const [name, svg] of deriveVariants(openLibrary({ shared, personal: null }))) put(shared, name, svg);
    // 個人の顔を消した後に残った派生
    put(personal, 'char-x-point-side-right-smile', charSvg('new-face'));
    put(personal, 'char-x-point-side-left-smile', charSvg('new-face'));
    put(personal, 'obj-y');
    const lib = openLibrary({ shared, personal });
    assert.deepEqual(redundantVariants(lib), ['char-x-point-side-right-smile', 'char-x-point-side-left-smile']);
    assert.equal(deriveVariants(lib).size, 0);
    assert.deepEqual(redundantVariants(openLibrary({ shared, personal: null })), []);
  });

  it('共有のポーズに個人で表情の置き場を足すと、顔を差し替えて個人に残す（左向きも書く）', () => {
    put(shared, 'char-x-stand-side-right-normal');
    put(shared, 'char-x-stand-side-right-smile');
    put(shared, 'char-x-point-side-right-normal');
    put(personal, 'char-x-point-side-right-smile', charSvg('char-x-point-side-right-normal'));
    const lib = openLibrary({ shared, personal });
    const out = deriveVariants(lib);
    assert.deepEqual([...out.keys()].sort(), ['char-x-point-side-left-smile', 'char-x-point-side-right-smile']);
    assert.ok(out.get('char-x-point-side-right-smile').includes('d="char-x-stand-side-right-smile"'));
    assert.deepEqual(redundantVariants(lib), []);
  });

  it('個人で描いた立ちポーズの表情は、表情違いの名前でも消さない', () => {
    put(shared, 'char-x-stand-normal');
    put(personal, 'char-x-stand-smile');
    assert.deepEqual(redundantVariants(openLibrary({ shared, personal })), []);
  });

  it('personal: null のときは全派生を返す', () => {
    put(shared, 'char-x-stand-side-right-normal');
    put(shared, 'char-x-stand-side-right-smile');
    const out = deriveVariants(openLibrary({ shared, personal: null }));
    assert.deepEqual([...out.keys()].sort(), ['char-x-stand-side-left-normal', 'char-x-stand-side-left-smile', 'char-x-stand-side-right-smile']);
  });
});
