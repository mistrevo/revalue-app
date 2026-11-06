// 共有の素材集の上に個人の素材集を重ねた見え方。同じ名前は個人を優先する。
// 素材はフォルダ直下の SVG だけ（検品記録の reviews/ などのフォルダは数えない）。
import fs from 'node:fs';
import path from 'node:path';

/** フォルダ直下の SVG の名前（拡張子なし）。フォルダが無ければ空 */
function svgNames(/** @type {string | null} */ dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.svg'))
    .map((e) => e.name.slice(0, -4))
    .sort();
}

/**
 * @typedef {{
 *   dirs: { shared: string, personal: string | null },
 *   names(): string[],
 *   read(name: string): string | undefined,
 *   readShared(name: string): string | undefined,
 *   origin(name: string): 'personal' | 'shared' | undefined,
 *   personalNames(): string[],
 * }} Library
 */

/**
 * 素材集を開く。personal が null なら共有だけを見る（共有の登録用）。呼ぶたびにフォルダを読み直す
 * @param {{ shared: string, personal: string | null }} dirs @returns {Library}
 */
export function openLibrary({ shared, personal }) {
  /** @returns {'personal' | 'shared' | undefined} */
  const origin = (/** @type {string} */ name) => {
    if (personal && fs.existsSync(path.join(personal, name + '.svg'))) return 'personal';
    if (fs.existsSync(path.join(shared, name + '.svg'))) return 'shared';
    return undefined;
  };
  return {
    dirs: { shared, personal },
    names: () => [...new Set([...svgNames(shared), ...svgNames(personal)])].sort(),
    personalNames: () => svgNames(personal),
    origin,
    readShared(name) {
      const file = path.join(shared, name + '.svg');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    },
    read(name) {
      const o = origin(name);
      if (!o) return undefined;
      return fs.readFileSync(path.join(/** @type {string} */ (o === 'personal' ? personal : shared), name + '.svg'), 'utf8');
    },
  };
}
