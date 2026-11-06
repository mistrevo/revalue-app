// シーンの HTML をブラウザで開くための材料（起動時に注入する値、ファイルの URL、ランタイムの注入）。
// 書き出し・静止画・点検のどれもが同じ手順でシーンを開けるよう、ここにまとめる。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RATIOS, sceneSlice, readTimeline } from './timeline.mjs';

const RUNTIME = new URL('./runtime/ms-runtime.js', import.meta.url);

/**
 * @typedef {{sceneId: string, ratio: string, width: number, height: number, seed: number,
 *   slice: ReturnType<typeof sceneSlice>}} SceneInit
 */

/**
 * ページへ window.__MS_INIT として渡す値を作る。
 * @param {string} projectDir 制作フォルダ
 * @param {string} sceneId
 * @param {string} ratio '16:9' など
 * @returns {SceneInit}
 */
export function sceneInit(projectDir, sceneId, ratio) {
  if (!(ratio in RATIOS)) throw new Error(`比率 ${ratio} は使えません（${Object.keys(RATIOS).join('、')} のどれか）`);
  const tl = readTimeline(projectDir);
  const [width, height] = RATIOS[ratio];
  return { sceneId, ratio, width, height, seed: tl.seed ?? 1, slice: sceneSlice(tl, sceneId) };
}

/**
 * シーンの HTML の file:// URL。timeline の file が無ければ src/scenes/<id>.html とみなす。
 * @param {string} projectDir
 * @param {string} sceneId
 */
export function sceneUrl(projectDir, sceneId) {
  const scene = readTimeline(projectDir).scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`シーン ${sceneId} が見つかりません`);
  const file = path.resolve(projectDir, scene.file ?? `src/scenes/${sceneId}.html`);
  if (!fs.existsSync(file)) throw new Error(`シーン ${sceneId} の HTML が見つかりません（${file}）`);
  return pathToFileURL(file).href;
}

/** ランタイム（ms-runtime.js）のソース */
export function runtimeSource() {
  return fs.readFileSync(RUNTIME, 'utf8');
}

/**
 * 次に開くページへ、__MS_INIT とランタイムを読み込みの前に注入する（この順で実行される）。
 * シーンの HTML はプラグインの場所を知らずに済む。
 * @param {any} page puppeteer の Page
 * @param {SceneInit} init
 */
export async function injectScene(page, init) {
  await page.evaluateOnNewDocument((v) => { window.__MS_INIT = v; }, init);
  await page.evaluateOnNewDocument(runtimeSource());
}
