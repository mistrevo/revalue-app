// 挿絵の素材集の目録（catalog.md）と一覧（gallery.html）が素材と食い違っていないこと。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { buildCatalog, buildGallery, galleryGroups } from '../scripts/catalog.mjs';
import { SHARED_DIR } from '../scripts/paths.mjs';

const allNames = () => fs.readdirSync(SHARED_DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4));
const read = (name) => fs.readFileSync(path.join(SHARED_DIR, name + '.svg'), 'utf8');

it('catalog.md が今の素材から作った目録と一致する', () => {
  const onDisk = fs.readFileSync(path.join(SHARED_DIR, 'catalog.md'), 'utf8');
  assert.equal(onDisk, buildCatalog(allNames(), read), '素材と目録が食い違っています');
});

it('gallery.html が今の素材から作った一覧と一致する', () => {
  const onDisk = fs.readFileSync(path.join(SHARED_DIR, 'gallery.html'), 'utf8');
  assert.equal(onDisk, buildGallery(allNames(), read), '素材と一覧が食い違っています');
});

it('素材に来歴情報（C2PA の metadata）が残っていない', () => {
  const left = fs.readdirSync(SHARED_DIR).filter((f) => f.endsWith('.svg') && /<metadata>|xmlns:c2pa/.test(fs.readFileSync(path.join(SHARED_DIR, f), 'utf8')));
  assert.deepEqual(left, []);
});

it('一覧は 1 枚の絵につき 1 カードにまとめ、右向き・普通の顔を先に出す', () => {
  const groups = galleryGroups(['char-pm-stand-side-left-normal', 'char-pm-stand-side-left-smile', 'char-pm-stand-side-right-normal', 'char-pm-stand-side-right-smile', 'char-pm-stand-normal', 'char-pm-point-smile', 'obj-x-side-left', 'obj-x-side-right', 'icon-y']);
  assert.deepEqual(groups.map((g) => g.names[0]).sort(), ['char-pm-point-smile', 'char-pm-stand-normal', 'char-pm-stand-side-right-normal', 'icon-y', 'obj-x-side-right']);
  // 件数は大量に消えていないかだけを見る下限（素材を足しても落ちない。中身の食い違いは目録・一覧の検査が捕まえる）
  const real = galleryGroups(allNames());
  assert.ok(real.length >= 284, `一覧のカードが 284 枚より少なくなりました（${real.length} 枚）`);
  const chars = real.filter((g) => g.key.startsWith('char-')).length;
  assert.ok(chars >= 106, `人物のカードが 106 枚より少なくなりました（${chars} 枚）`);
});
