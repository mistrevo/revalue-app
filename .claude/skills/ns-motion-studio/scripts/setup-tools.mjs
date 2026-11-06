// 動画制作の道具を ~/.claude/ns-motion-studio/tools/ へ入れる。試した版とブラウザ本体がそろっていれば何もしない。
// 依存の依存まで試した版にそろえるため、プラグインに同梱した package.json と package-lock.json を写して npm ci で入れる。
// ブラウザ本体（puppeteer の chrome-headless-shell）も同じ置き場の chrome/ に入れる（PUPPETEER_CACHE_DIR）。
//   node <ns-motion-studio プラグイン>/scripts/setup-tools.mjs
// 終了コード: そろえば 0、入れられなければ 1（取得先と、情報システムに伝える内容を出す）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, toolsDir } from './paths.mjs';
import { browserExecutable } from './tools.mjs';

/** 入れる道具と、試した版（版を上げるときは、tools/ の package.json と package-lock.json を作り直し、全部のテストを通してからここを変える） */
export const TOOL_VERSIONS = { puppeteer: '25.15.0', 'ffmpeg-static': '5.3.0', 'ffprobe-static': '3.1.0' };
export const TOOL_PACKAGES = Object.keys(TOOL_VERSIONS);

/** 同梱の package.json と package-lock.json の置き場（プラグインの tools/） */
export const LOCK_DIR = fileURLToPath(new URL('../tools/', import.meta.url));

/**
 * 道具置き場に入っている版（無ければ null）
 * @param {string} tools
 * @param {string} name
 * @returns {string|null}
 */
export function installedVersion(tools, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tools, 'node_modules', name, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** 無い道具と、試した版と違う道具 */
export const outdatedTools = (tools) => TOOL_PACKAGES.filter((p) => installedVersion(tools, p) !== TOOL_VERSIONS[p]);

/** 入れるコマンド（写した package-lock.json のとおりに入れる） */
export const installCommand = (tools) => `npm ci --prefix "${tools}"`;

/** 入れるときの環境変数。ブラウザ本体を道具置き場の chrome/ に入れる（利用者が PUPPETEER_CACHE_DIR を決めていれば、それを使う） */
export const installEnv = (tools, env = process.env) => ({ ...env, PUPPETEER_CACHE_DIR: env.PUPPETEER_CACHE_DIR || path.join(tools, 'chrome') });

/** ブラウザ本体だけを入れる、puppeteer の CLI の引数（node で実行する） */
export const browserInstallArgs = (tools) =>
  [path.join(tools, 'node_modules', 'puppeteer', 'lib', 'puppeteer', 'node', 'cli.js'), 'browsers', 'install', 'chrome-headless-shell'];

/** 取得に失敗したときの案内（社内のプロキシや証明書で止まることが多いので、情報システムに伝える内容を出す） */
export const NETWORK_HELP = [
  '道具を取りに行く先は次の3つです。会社のネットワークで止められていないかを確かめてください。',
  '  - registry.npmjs.org（npm のパッケージ）',
  '  - github.com（ffmpeg の実行ファイル）',
  '  - storage.googleapis.com（描画に使うブラウザ本体）',
  'プロキシを通す必要がある場合は、環境変数 HTTPS_PROXY（と npm の proxy 設定）が要ります。',
  '社内の証明書で通信を見ている場合は、環境変数 NODE_EXTRA_CA_CERTS に証明書のファイルを指定します。',
  '分からなければ、この文をそのまま情報システムの担当に見せてください。入れられない場合は、道具なしで進める方法に切り替えられます。',
].join('\n');

/** コマンドを実行して終了コードを返す。shell は 1 本の文字列（Windows の npm は .cmd のため shell が要る）、node は node で実行する引数 */
function defaultRun({ shell, node, env }) {
  const r = shell
    // 引数配列と shell: true を併用すると DEP0190 警告が出るので、コマンドを 1 本の文字列で渡す
    ? spawnSync(shell, { stdio: 'inherit', shell: true, env })
    : spawnSync(process.execPath, node, { stdio: 'inherit', env });
  return r.status ?? 1;
}

/**
 * 道具とブラウザ本体をそろえる。
 * @param {{tools?: string, env?: Record<string, string|undefined>, run?: (r: {shell?: string, node?: string[], env: Record<string, string|undefined>}) => number,
 *   browser?: (tools: string, env: Record<string, string|undefined>) => string|null, log?: (m: string) => void, error?: (m: string) => void}} [opts]
 * @returns {number} 終了コード
 */
export function setupTools({ tools = toolsDir(), env = process.env, run = defaultRun, browser = browserExecutable, log = console.log, error = console.error } = {}) {
  const runEnv = installEnv(tools, env);
  let did = false;
  const need = outdatedTools(tools);
  if (need.length) {
    fs.mkdirSync(tools, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(LOCK_DIR, f), path.join(tools, f));
    log(`${need.map((p) => `${p} ${TOOL_VERSIONS[p]}`).join('、')} を入れます（数分〜15分ほど。約 1 GB）: ${tools}`);
    if (run({ shell: installCommand(tools), env: runEnv }) !== 0 || outdatedTools(tools).length) {
      error(`道具を入れられませんでした。\n${NETWORK_HELP}`);
      return 1;
    }
    did = true;
  }
  // 前の置き場（~/.cache/puppeteer）にあれば、描画はそれを使うので入れ直さない（browserExecutable は描画と同じ順で探す）
  if (!browser(tools, env)) {
    log(`描画に使うブラウザ本体を入れます: ${runEnv.PUPPETEER_CACHE_DIR}`);
    if (run({ node: browserInstallArgs(tools), env: runEnv }) !== 0 || !browser(tools, runEnv)) {
      error(`描画に使うブラウザ本体を入れられませんでした（道具の取得はできても、ブラウザ本体の取得先だけが止められていることがあります）。\n${NETWORK_HELP}`);
      return 1;
    }
    did = true;
  }
  log(did ? '入れました。' : `入っています: ${tools}`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(setupTools());
}
