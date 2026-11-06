// 挿絵の素材を登録する。派生（左向き・表情違い）を書き出し、目録 catalog.md と一覧 gallery.html を作り直す。
// 使い方:
//   node <ns-illustrations プラグイン>/scripts/register.mjs            個人の素材集（~/.claude/ns-illustrations/illustrations/）へ書き出す
//   node plugins/ns-illustrations/scripts/register.mjs --shared        共有の素材集へ書き出す（マージする人と、プルリクを作るとき）
// 個人の素材集は共有の素材集の上に重ねて計算し、個人の絵を元にした派生と、個人の素材集にある派生の名前のファイル（表情の置き場など）を
// 個人の素材集へ書く。作り直すと共有の同じ名前のファイルと一致する派生は、個人の素材集から消す。
// 個人の catalog と gallery は個人由来の名前だけを並べる。
import fs from 'node:fs';
import path from 'node:path';
import { buildCatalog, buildGallery } from './catalog.mjs';
import { openLibrary } from './library.mjs';
import { SHARED_DIR, isMain, personalDir } from './paths.mjs';
import { deriveVariants, redundantVariants } from './variants.mjs';

/** 中身が変わるときだけ書く（変わらないファイルの更新時刻を動かさない） */
function write(/** @type {string} */ file, /** @type {string} */ text) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.writeFileSync(file, text);
}

/**
 * 個人の素材集では、作り直すと共有の同じ名前のファイルと一致する派生を消す（残す意味が無い）
 * @param {{ shared: boolean }} opts @returns {{ dir: string, variants: number, names: number, removed: string[] }}
 */
export function register({ shared }) {
  const dir = shared ? SHARED_DIR : personalDir();
  if (!shared) fs.mkdirSync(dir, { recursive: true });
  const lib = openLibrary({ shared: SHARED_DIR, personal: shared ? null : dir });
  const variants = deriveVariants(lib);
  const removed = redundantVariants(lib);
  for (const name of removed) fs.rmSync(path.join(dir, name + '.svg'));
  for (const [name, svg] of variants) write(path.join(dir, name + '.svg'), svg);
  // 書き出した派生を含めて読み直す
  const names = shared ? lib.names() : lib.personalNames();
  const read = (/** @type {string} */ n) => /** @type {string} */ (lib.read(n));
  write(path.join(dir, 'catalog.md'), buildCatalog(names, read, { personal: !shared }));
  write(path.join(dir, 'gallery.html'), buildGallery(names, read, { personal: !shared }));
  return { dir, variants: variants.size, names: names.length, removed };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--shared');
  if (unknown.length) {
    console.error(`知らない引数です: ${unknown.join(' ')}（使えるのは --shared だけ）`);
    process.exit(2);
  }
  const shared = args.includes('--shared');
  /** @type {ReturnType<typeof register>} */
  let r;
  try {
    r = register({ shared });
  } catch (e) {
    // 命名規則違反など、利用者が直すもの。スタックトレースは出さない
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  for (const name of r.removed) console.log(`削除: 共有と同じ派生 ${name}`);
  console.log(`書き出し先: ${shared ? '共有の素材集' : '個人の素材集'}（${r.dir}）`);
  console.log('書き出し: 派生', r.variants, '点（左向き・表情違い）');
  console.log('書き出し:', path.join(r.dir, 'catalog.md'), `（素材 ${r.names} 点）`);
  console.log('書き出し:', path.join(r.dir, 'gallery.html'));
}
