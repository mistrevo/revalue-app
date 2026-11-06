// 素材集の置き場。共有はプラグインに同梱、個人は利用者のホームの下（固定。設定で変えない）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 共有の素材集（プラグインに同梱。プラグインのインストール先へは書き込まない） */
export const SHARED_DIR = fileURLToPath(new URL('../assets/illustrations', import.meta.url));

/** 個人の素材集 */
export function personalDir() {
  return path.join(os.homedir(), '.claude/ns-illustrations/illustrations');
}

/** 検品記録 */
export function reviewsDir() {
  return path.join(personalDir(), 'reviews');
}

/** 道具 */
export function toolsDir() {
  return path.join(os.homedir(), '.claude/ns-illustrations/tools');
}

/**
 * このモジュールが node で直接実行されたか。シンボリックリンクやジャンクション越しに呼ばれても判定できるよう、
 * 両側を実体のパスへ解決して比べる（path.resolve だけだと false になり、CLI が何もせず exit 0 で終わる）。
 * @param {string} metaUrl 呼び出し側の import.meta.url
 */
export function isMain(metaUrl) {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fs.realpathSync(path.resolve(arg)) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
