// 動画制作を始められる環境かを確かめる。
//   node doctor.mjs          やさしい説明を出す
//   node doctor.mjs --json   結果をそのまま JSON で出す
// 終了コード: 必須が揃っていれば 0、足りなければ 1（VOICEVOX と Gemini のキーは任意なので影響しない）。
import { isMain, toolsDir } from './paths.mjs';
import { installedVersion, TOOL_PACKAGES, TOOL_VERSIONS } from './setup-tools.mjs';
import { browserExecutable, bundledBinary, defaultExec, hasPackage, SETUP_COMMAND } from './tools.mjs';

/** 必要な Node の版（puppeteer 25 の engines が >=22.12.0） */
const NEED_NODE = '22.12.0';

/** 版の文字（v22.12.0 など）が need 以上か。主・副・修正の番号を順に比べる */
function versionAtLeast(version, need) {
  const parse = (v) => (/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v) ?? []).slice(1, 4).map((x) => Number(x ?? 0));
  const a = parse(version), b = parse(need);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
const VOICEVOX_URL = 'http://127.0.0.1:50021/version';

/**
 * @typedef {object} Report
 * @property {{ok: boolean, version: string, need: string}} node
 * @property {{ok: boolean, missing: string[], outdated: string[], versions: Record<string, string|null>, expected: Record<string, string>}} tools
 *   outdated は、入っているが試した版と違う道具。versions は入っている版
 * @property {{ok: boolean, path: string|null, source: 'system'|'bundled'|null}} ffmpeg
 * @property {{ok: boolean, path: string|null}} browser 描画に使うブラウザ本体（chrome-headless-shell）
 * @property {{running: boolean}} voicevox
 * @property {{keySet: boolean}} gemini
 * @property {boolean} ok
 */

/**
 * 環境を調べる。外へ出る部分（コマンド実行・通信・道具置き場・環境変数・node の版）は差し替えられる。
 * @param {{exec?: (cmd: string) => string|null, fetch?: typeof fetch, toolsDir?: string, env?: Record<string, string|undefined>, nodeVersion?: string,
 *   browser?: (tools: string, env: Record<string, string|undefined>) => string|null}} [env]
 * @returns {Promise<Report>}
 */
export async function diagnose(env = {}) {
  const exec = env.exec ?? defaultExec;
  const doFetch = env.fetch ?? globalThis.fetch;
  const tools = env.toolsDir ?? toolsDir();
  const vars = env.env ?? process.env;
  const version = env.nodeVersion ?? process.version;

  const node = { ok: versionAtLeast(version, NEED_NODE), version, need: NEED_NODE };

  const missing = TOOL_PACKAGES.filter((p) => !hasPackage(tools, p));
  const versions = Object.fromEntries(TOOL_PACKAGES.map((p) => [p, installedVersion(tools, p)]));
  const outdated = TOOL_PACKAGES.filter((p) => !missing.includes(p) && versions[p] !== TOOL_VERSIONS[p]);
  const toolsInfo = { ok: missing.length === 0 && outdated.length === 0, missing, outdated, versions, expected: TOOL_VERSIONS };

  /** @type {Report['ffmpeg']} */
  let ffmpeg = { ok: false, path: null, source: null };
  if (exec('ffmpeg -version') !== null) {
    ffmpeg = { ok: true, path: 'ffmpeg', source: 'system' };
  } else {
    const b = bundledBinary(tools, 'ffmpeg-static');
    if (b) ffmpeg = { ok: true, path: b, source: 'bundled' };
  }

  let running = false;
  try {
    const res = await doFetch(VOICEVOX_URL, { signal: AbortSignal.timeout(1500) });
    running = Boolean(res?.ok);
  } catch {
    running = false;
  }

  const exe = (env.browser ?? browserExecutable)(tools, vars);
  const browser = { ok: Boolean(exe), path: exe ?? null };

  const gemini = { keySet: Boolean(vars.GEMINI_API_KEY) };
  return { node, tools: toolsInfo, ffmpeg, browser, voicevox: { running }, gemini, ok: node.ok && toolsInfo.ok && ffmpeg.ok && browser.ok };
}

/**
 * Report をやさしい日本語にする
 * @param {Report} r
 */
export function describe(r) {
  const setup = SETUP_COMMAND;
  const L = [];
  L.push(r.node.ok
    ? `[OK] Node.js ${r.node.version}`
    : `[要対応] Node.js ${r.node.version} は古いです（${r.node.need} 以上が必要）。入れ方は setup.md の「Node を入れる」（入れたら Claude Code を開き直す）`);
  const vers = TOOL_PACKAGES.map((p) => `${p} ${r.tools.versions?.[p] ?? '-'}`).join('、');
  L.push(r.tools.ok
    ? `[OK] 描画と書き出しの道具（${vers}）`
    : r.tools.missing.length
      ? `[要対応] 道具が足りません（${r.tools.missing.join('、')}）。次を実行してください: ${setup}`
      : `[要対応] 道具の版が試した版と違います（${r.tools.outdated.map((p) => `${p} ${r.tools.versions[p]}、試した版は ${r.tools.expected[p]}`).join('。')}）。次を実行して入れ直してください: ${setup}`);
  L.push(r.ffmpeg.ok
    ? `[OK] 動画の書き出し（ffmpeg: ${r.ffmpeg.source === 'system' ? 'お使いのパソコンのもの' : '道具置き場のもの'}）`
    : `[要対応] ffmpeg が見つかりません。次を実行してください: ${setup}`);
  L.push(r.browser.ok
    ? '[OK] 描画に使うブラウザ本体'
    : `[要対応] 描画に使うブラウザ本体が見つかりません。次を実行してください: ${setup}`);
  L.push(r.voicevox.running
    ? '[OK] VOICEVOX が起動しています（ナレーションを作れます）'
    : '[任意] VOICEVOX は起動していません。ナレーション音声を作るときだけ必要です');
  L.push(r.gemini.keySet
    ? '[OK] GEMINI_API_KEY が設定されています（ナレーション音声と BGM を使えます）'
    : '[任意] GEMINI_API_KEY が未設定です。ナレーション音声や BGM の生成を使うときだけ必要です');
  L.push('', r.ok ? '動画づくりを始められます。' : '足りないものを整えてから始めましょう。');
  return L.join('\n');
}

if (isMain(import.meta.url)) {
  const r = await diagnose();
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : describe(r));
  process.exit(r.ok ? 0 : 1);
}
