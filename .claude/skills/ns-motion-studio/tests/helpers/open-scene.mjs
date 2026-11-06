// テスト用: 制作フォルダのシーンを、書き出しと同じ注入のしかたで開く。
import { injectScene, sceneInit, sceneUrl } from '../../scripts/scene-page.mjs';

/**
 * @param {any} browser puppeteer の Browser
 * @param {string} projectDir
 * @param {string} sceneId
 * @param {{ratio?: string, seed?: number}} [opts] seed を渡すと timeline の seed を上書きする
 * @returns {Promise<any>} 読み込みを終えた Page
 */
export async function openScene(browser, projectDir, sceneId, { ratio = '16:9', seed } = {}) {
  const init = sceneInit(projectDir, sceneId, ratio);
  if (seed !== undefined) init.seed = seed;
  const page = await browser.newPage();
  await page.setViewport({ width: init.width, height: init.height, deviceScaleFactor: 1 });
  await injectScene(page, init);
  await page.goto(sceneUrl(projectDir, sceneId), { waitUntil: 'load' });
  return page;
}
