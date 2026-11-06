// 制作フォルダと project.json の読み書き（spec 4.2）。
//   node project.mjs init <制作フォルダ> --title "題名"
//   node project.mjs approve <制作フォルダ> <briefing|style|storyboard|plan|rough|deliver> [--note "…"]（brief も briefing として受け付ける）
//   node project.mjs stage <制作フォルダ> <段階>
//   node project.mjs course <制作フォルダ> trial|sample|full   工程の長さ（お試し・サンプル・本番）
//   node project.mjs intent <制作フォルダ> --check <点検の名前> --why "理由" [--scenes s01,s02]   既定から外す演出の宣言
//   node project.mjs fallback <制作フォルダ> on|off   道具を入れられないときの逃げ道（Claude Motion）に切り替えた記録
import fs from 'node:fs';
import path from 'node:path';
import { isMain, replaceFile } from './paths.mjs';

/** 制作の段階 */
export const STAGES = ['setup', 'briefing', 'style', 'storyboard', 'audio', 'build', 'export', 'deliver', 'revise'];

/** 制作フォルダに作るディレクトリ（briefing.md などの文書はスキルが後で書く） */
const DIRS = ['assets', 'audio', 'src/scenes', 'reviews', 'out'];

/**
 * 制作フォルダの .gitignore。作り直せる中間データとキャッシュ、大きい動画と音声（wav）は git に入れない。
 * 書き出した動画と音声は git の外で渡す・残すので、作ったときに利用者へ伝える（GITIGNORE_NOTE）。
 */
export const GITIGNORE = `# ns-motion-studio が作った。作り直せる中間データと、大きい動画・音声は git に入れない
out/.scenes/
out/.lock
out/progress.log
out/*.partial*
out/*.list.txt
out/*.mp4
reviews/.check-cache/
reviews/frames/
reviews/strip-*.png
reviews/checks-*.json
reviews/feedback-in.txt
audio/.narration-partial/
audio/master.json
audio/**/*.wav
*.tmp
*.partial
`;

/** .gitignore を置いたときに利用者へ伝える文 */
export const GITIGNORE_NOTE = '制作フォルダに .gitignore を置きました。書き出した動画（out/*.mp4）と音声（audio/ の wav）、作り直せる中間データは git に入りません。動画と音声は git の外で渡す・残してください。';

/** 関門。plan はサンプルの「構成の確認」（briefing・style・storyboard をまとめて承認する） */
export const GATES = ['briefing', 'style', 'storyboard', 'plan', 'rough', 'deliver'];

/** 工程の長さ。trial はお試し、sample はサンプル、full は本番 */
export const COURSES = ['trial', 'sample', 'full'];

/** コースごとに、使う人の承認が要る関門（この順） */
export const COURSE_GATES = {
  trial: ['deliver'],
  sample: ['plan', 'deliver'],
  full: ['briefing', 'style', 'storyboard', 'rough', 'deliver'],
};

/** plan の承認でまとめて承認する関門 */
const PLAN_COVERS = ['briefing', 'style', 'storyboard'];

/** 意図した演出として宣言できる点検（text-mismatch・hardcoded-text・determinism・media・script-error は正しく作るための点検なので外せない） */
export const INTENT_CHECKS = ['overflow', 'safe-area', 'overlap', 'cover', 'blank', 'contrast', 'hold', 'narration', 'flash', 'loudness', 'loop'];

/** 初版の settings.type を、呼び名（settings.kind）に読み替える */
const KIND_OF_TYPE = {
  'logo-reveal': 'ロゴリビール',
  'product-launch': '製品ローンチ',
  'product-intro': '製品紹介',
  'service-intro': 'サービス紹介',
  'tech-explainer': '技術解説',
  'product-manual': '製品マニュアル',
  'company-intro': '会社紹介',
};

/** 初版の名前（brief）を今の名前（briefing）にする。ほかはそのまま */
export const normalizeName = (name) => (name === 'brief' ? 'briefing' : name);

/**
 * @typedef {'trial'|'sample'|'full'} Course
 * @typedef {{approvedAt?: string, note?: string, via?: 'plan', skipped?: true, at?: string}} GateRecord
 *   via: 'plan' は構成の確認でまとめて承認したもの、skipped はコースで省いたもの
 * @typedef {{check: string, why: string, scenes?: string[], addedAt: string, stage: string}} Intent
 * @typedef {{
 *   title: string, createdAt: string, stage: string,
 *   gates: {briefing?: GateRecord, style?: GateRecord, storyboard?: GateRecord, plan?: GateRecord, rough?: GateRecord, deliver?: GateRecord},
 *   gateHistory?: Array<{gate: string, record: GateRecord, until: string}>,
 *   settings: {kind: string, course: Course, fps: number, ratios: string[], loop: boolean,
 *     audio: {narration: 'none'|'voicevox'|'gemini', bgm: 'none'|'lyria'|'file', sfx: boolean},
 *     fallback?: 'claude-motion', intent?: Intent[]},
 *   models: Array<{kind: 'tts'|'music', model: string, date: string, prompt?: string,
 *     voice?: string, character?: string, style?: string, speaker?: number, speed?: number, intonation?: number}>,
 *   credits?: string[],
 *   externalApiConsent?: {date: string, notice: string}
 * }} Project
 */

const file = (dir) => path.join(dir, 'project.json');

/**
 * ブリーフィングの文書の場所。briefing.md が無く、初版の brief.md があればそちら。
 * @param {string} dir
 */
export function briefingFile(dir) {
  const now = path.join(dir, 'briefing.md');
  const old = path.join(dir, 'brief.md');
  return !fs.existsSync(now) && fs.existsSync(old) ? old : now;
}

/**
 * 初版の project.json を今の形に読み替える（メモリの上だけ。何かを書いたときに今の形で保存される）。
 * stage と gates の brief → briefing、settings.type → settings.kind、course が無ければ full（初版は本番の工程だけだった）。
 * @param {any} p
 * @returns {Project}
 */
function migrate(p) {
  p.stage = normalizeName(p.stage);
  p.gates ??= {};
  if (p.gates.brief) {
    p.gates.briefing ??= p.gates.brief;
    delete p.gates.brief;
  }
  p.settings ??= {};
  if ('type' in p.settings) {
    p.settings.kind ??= KIND_OF_TYPE[p.settings.type] ?? String(p.settings.type ?? '');
    delete p.settings.type;
  }
  p.settings.kind ??= '';
  p.settings.course ??= 'full';
  return p;
}

/** @returns {Project} */
export function readProject(dir) {
  let p;
  try {
    p = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
  } catch (e) {
    throw new Error(`project.json を読めません（${file(dir)}）: ${e.message}`);
  }
  return migrate(p);
}

/** 一時ファイルに書いてから名前を変えて置き換える（途中で止まっても壊れない） */
export function writeProject(dir, p) {
  const tmp = `${file(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
  replaceFile(tmp, file(dir));
}

/**
 * 制作フォルダに .gitignore が無ければ置く。あれば利用者が手を入れているかもしれないので書き換えない。
 * @returns {boolean} 置いたか
 */
export function writeGitignore(dir) {
  const f = path.join(dir, '.gitignore');
  if (fs.existsSync(f)) return false;
  fs.writeFileSync(f, GITIGNORE);
  return true;
}

/**
 * 制作フォルダを作り、project.json を書く。既にあれば上書きせず読んで返す。
 * @returns {Project}
 */
export function initProject(dir, { title }) {
  for (const d of DIRS) fs.mkdirSync(path.join(dir, d), { recursive: true });
  writeGitignore(dir);
  if (fs.existsSync(file(dir))) return readProject(dir);
  /** @type {Project} */
  const p = {
    title,
    createdAt: new Date().toISOString(),
    stage: 'setup',
    gates: {},
    settings: {
      kind: '',
      course: 'full',
      fps: 30,
      ratios: ['16:9'],
      loop: false,
      audio: { narration: 'none', bgm: 'none', sfx: false },
    },
    models: [],
  };
  writeProject(dir, p);
  return p;
}

/** 関門を承認済みにする。plan なら、ブリーフィング・スタイル・絵コンテも via: 'plan' でまとめて承認する */
export function approveGate(dir, gate, note) {
  gate = normalizeName(gate);
  if (!GATES.includes(gate)) throw new Error(`知らない関門です: ${gate}（${GATES.join('、')} のいずれか）`);
  const p = readProject(dir);
  if (gate === 'plan' && p.settings.course !== 'sample') {
    throw new Error(`構成の確認（plan）は、サンプルのコースだけで使います（今のコースは ${p.settings.course}）。本番では briefing・style・storyboard を1つずつ承認してください。`);
  }
  const approvedAt = new Date().toISOString();
  p.gates[gate] = { approvedAt, ...(note ? { note } : {}) };
  if (gate === 'plan') for (const g of PLAN_COVERS) p.gates[g] = { approvedAt, via: 'plan' };
  writeProject(dir, p);
  return p;
}

/** 段階を進める（戻すこともできる） */
export function setStage(dir, stage) {
  stage = normalizeName(stage);
  if (!STAGES.includes(stage)) throw new Error(`知らない段階です: ${stage}（${STAGES.join('、')} のいずれか）`);
  const p = readProject(dir);
  p.stage = stage;
  writeProject(dir, p);
  return p;
}

/**
 * コース（工程の長さ）を変える。
 * 本番に上げると、構成の確認でまとめた承認（via: 'plan'）と plan、省いた印を gateHistory に移して外す（1つずつ承認を取り直す）。
 * お試しかサンプルにすると、本番の関門のうち、未承認でそのコースに無いものに「省いた」と記録する。
 * @param {string} dir
 * @param {Course} course
 */
export function setCourse(dir, course) {
  if (!COURSES.includes(course)) throw new Error(`知らないコースです: ${course}（${COURSES.join('、')} のいずれか）`);
  const p = readProject(dir);
  const now = new Date().toISOString();
  if (course === 'full') {
    for (const [gate, record] of Object.entries(p.gates)) {
      if (gate === 'plan' || record.via === 'plan' || record.skipped) {
        (p.gateHistory ??= []).push({ gate, record, until: now });
        delete p.gates[gate];
      }
    }
  } else {
    for (const g of COURSE_GATES.full) {
      if (!COURSE_GATES[course].includes(g) && !p.gates[g]?.approvedAt) p.gates[g] = { skipped: true, at: now };
    }
  }
  p.settings.course = course;
  writeProject(dir, p);
  return p;
}

/**
 * 既定から外す演出を宣言する（その点検の指摘を「意図どおり」にする）。足した日時と段階を残す。
 * @param {string} dir
 * @param {{check: string, why: string, scenes?: string[]}} intent
 */
export function addIntent(dir, { check, why, scenes }) {
  if (!INTENT_CHECKS.includes(check)) {
    throw new Error(`${check} は宣言できません（正しく作るための点検か、知らない名前です。宣言できるのは ${INTENT_CHECKS.join('、')}）`);
  }
  if (!why?.trim()) throw new Error('理由（--why）を書いてください。演出の意図がブリーフィングかスタイルの方向から言えるときだけ宣言します。');
  const p = readProject(dir);
  (p.settings.intent ??= []).push({ check, why: why.trim(), ...(scenes?.length ? { scenes } : {}), addedAt: new Date().toISOString(), stage: p.stage });
  writeProject(dir, p);
  return p;
}

/**
 * 意図の宣言（settings.intent）の scenes のうち、timeline.json に無いシーンの id（打ち間違いや、消した・名前を変えたシーン）
 * @param {Array<{scenes?: string[]}>} intents
 * @param {{scenes: Array<{id: string}>}} tl
 */
export function unknownIntentScenes(intents, tl) {
  const ids = new Set(tl.scenes.map((s) => s.id));
  return [...new Set(intents.flatMap((x) => (x.scenes ?? []).filter((s) => !ids.has(s))))];
}

/**
 * 書き出しの前に、宣言に timeline.json に無いシーンが残っていないかを確かめる（長い書き出しの後の点検で初めて止まらないように）。
 * project.json が無い・読めないときは何もしない。
 * @param {string} dir
 * @param {{scenes: Array<{id: string}>}} tl
 */
export function assertIntentScenes(dir, tl) {
  let intents;
  try {
    intents = readProject(dir).settings.intent ?? [];
  } catch {
    return;
  }
  const unknown = unknownIntentScenes(intents, tl);
  if (unknown.length) {
    throw new Error(`project.json の settings.intent の scenes に、timeline.json に無いシーンがあります: ${unknown.join('、')}（今のシーンは ${tl.scenes.map((s) => s.id).join('、')}）。`
      + 'その id を settings.intent から外すか、今のシーンの id に直してから実行してください。');
  }
}

/**
 * 道具を入れられず、Claude Motion へ渡す逃げ道に切り替えたかを記録する。再開したときは、これを見て道具の導入を繰り返さない。
 * @param {string} dir
 * @param {boolean} on true で settings.fallback = 'claude-motion'、false で外す
 */
export function setFallback(dir, on) {
  const p = readProject(dir);
  if (on) p.settings.fallback = 'claude-motion';
  else delete p.settings.fallback;
  writeProject(dir, p);
  return p;
}

if (isMain(import.meta.url)) {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const usage = `使い方: node project.mjs init <制作フォルダ> --title "題名" / approve <制作フォルダ> <${GATES.join('|')}> [--note "…"] / stage <制作フォルダ> <${STAGES.join('|')}>`
    + ` / course <制作フォルダ> <${COURSES.join('|')}> / intent <制作フォルダ> --check <${INTENT_CHECKS.join('|')}> --why "理由" [--scenes s01,s02] / fallback <制作フォルダ> on|off`;
  try {
    if (cmd === 'init' && dir) {
      const title = opt('title');
      if (!title) throw new Error(`--title が必要です\n${usage}`);
      const hadIgnore = fs.existsSync(path.join(dir, '.gitignore'));
      const p = initProject(dir, { title });
      console.log(`制作フォルダ: ${path.resolve(dir)}（段階: ${p.stage}）`);
      if (!hadIgnore) console.log(GITIGNORE_NOTE);
    } else if (cmd === 'approve' && dir && rest[0]) {
      const gate = normalizeName(rest[0]);
      approveGate(dir, gate, opt('note'));
      console.log(gate === 'plan' ? '構成の確認（plan）を承認済みにしました（ブリーフィング・スタイル・絵コンテもまとめて承認しました）' : `関門 ${gate} を承認済みにしました`);
    } else if (cmd === 'stage' && dir && rest[0]) {
      setStage(dir, rest[0]);
      console.log(`段階を ${normalizeName(rest[0])} にしました`);
    } else if (cmd === 'course' && dir && rest[0]) {
      setCourse(dir, /** @type {Course} */ (rest[0]));
      console.log(`コースを ${rest[0]} にしました`);
    } else if (cmd === 'intent' && dir && opt('check')) {
      const scenes = opt('scenes')?.split(',').map((x) => x.trim()).filter(Boolean);
      addIntent(dir, { check: opt('check'), why: opt('why') ?? '', scenes });
      console.log(`既定から外す演出として ${opt('check')} を宣言しました${scenes?.length ? `（シーン: ${scenes.join('、')}）` : ''}`);
    } else if (cmd === 'fallback' && dir && (rest[0] === 'on' || rest[0] === 'off')) {
      setFallback(dir, rest[0] === 'on');
      console.log(rest[0] === 'on' ? '道具なしの逃げ道（Claude Motion）に切り替えたことを記録しました' : '逃げ道の記録を外しました');
    } else {
      throw new Error(usage);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
