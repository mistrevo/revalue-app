// 自動点検。人が見る前に、機械で分かる不具合（文字のはみ出し・重なり・原稿との食い違い・読みにくさ・
// 表示時間の不足・描画のエラー・決定論の崩れ、完成版の点滅・尺・音量・ループ）を見つける。
//
// シーンの点検は、シーンを1枚のページで開き、0.2 秒刻み（とシーンの最後のフレーム）で seek して
// __ms.layout() を見る。文字は、祖先まで掛け合わせた不透明度が 0.5 以上のときだけ「見えている」とする。
// コントラストは、文字が出そろった（不透明度 0.99 以上の）フレームだけで測る。足りていた文字は、位置・色・重なった面が変わるか、
// CONTRAST_RECHECK 秒たつまで測り直さない。
// 重なりはマスク（overflow・clip-path）で切った箱で見る。画面の外へのはみ出しと字幕用の場所は、切る前の箱で見る。
// 表示のあいだ一度も全体が見えなかった文字（小さな箱で切れたまま、省略記号で切ったなど）も、はみ出しとして指摘する。
// data-ms-scroll の箱の中（流れる文字やクレジット）は、切れていてもよい。
// 表示のあいだ一度も、背景の箱（文字のいちばん近い、背景の色か画像・枠線・影のある祖先。画面全体を覆う箱は除く）に
// 収まらなかった文字も、はみ出しとして指摘する。収まったと数えるのは、文字が全部見えている（マスクで切れていない）時刻だけ。
// 切れたまま・はみ出したままは文字ノードごとに数える（語ごとの span を順に出す見出しで、先に出た語だけで「収まった」としない）。
// 文字の上（重なり順で手前）に、文字でない塗りのある要素（図形・面・画像）が字の帯の 10% を超えて重なったまま 0.2 秒以上続けば、
// cover として指摘する（ms-runtime.js の covers()。data-ms-wipe を付けた要素と、mix-blend-mode が normal でない要素は数えない）。
// 限界: 9 割以上を覆う形は、文字を隠しておいて出す板とみなして cover に数えない。一度読ませた後で形が文字を覆い隠しても指摘しない。
// カットの最初のコマ（60fps なら最初の2コマまで）だけが背景だけで、前のカットの最後のコマに絵があり、すぐ後のコマでもう絵が出そろっていれば、
// つなぎ目のちらつき（blank）として指摘する（何も無い地からだんだん出る入場は問わない）。
// 完成版の点検は、書き出した MP4 を ffmpeg / ffprobe で測る。
//
// 意図した演出（使う人の意図で既定から外したもの）は、project.json の settings.intent（動画全体か、scenes で絞ったシーン）と、
// シーンの要素の data-ms-intent（その要素と中の要素。body に付ければシーン全体）で宣言する。宣言に当たった指摘は intended: true を付けて残し、
// 合否と止め時に数えない。原稿との食い違い・直書き・決定論・MP4 の尺と解像度・描画のエラーは、正しく作るための点検なので宣言が効かない。
//
// 限界:
// - 点滅は画面全体の平均輝度で見る。画面の一部だけが激しく点滅しても、平均が大きく動かなければ見逃す。
// - 決定論は、縁のわずかな揺れ（DET_LEVELS・DET_PIXELS 以内）を許す。それより小さな食い違いは見逃す。
// - Chrome は動いている層を、それまでに撮った一番大きい倍率で描き続ける。順に撮る書き出しと違い、
//   時刻を飛ばして撮るスチルやコンタクトシートは、動画のコマと縁の数画素が違うことがある。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { readFeedbackLog } from './feedback.mjs';
import { assertIntentScenes, INTENT_CHECKS, readProject } from './project.mjs';
import { formatTime } from './frames.mjs';
import { isMain, removeFile, replaceFile } from './paths.mjs';
import { beginRun } from './lock.mjs';
import { checkArgs, frameTime, LAUNCH_ARGS, openPage, outputSpec, pageHash, ratioDir, sceneFrames } from './render.mjs';
import {
  cutOf, hasVoiceOrMusic, holdHint, holdViolations, narrationOverlaps, overlapMessage, RATIOS, validateTimeline, readTimeline,
} from './timeline.mjs';
import { ffmpegPath, ffprobePath, loadPuppeteer, measureLoudness } from './tools.mjs';

/**
 * 文字の配置を見る間隔（秒）。限界: これより短いあいだだけ起きる不具合（一瞬の重なり・はみ出し）は見逃すことがある。
 * 文字の上の形（cover）は、続けて見た2つの時刻でどちらも隠れていたときだけ数えるので、0.4 秒より短い重なりは見逃すことがある
 */
const STEP = 0.2;
/** 画面の撮り方。圧縮を弱くして速く撮る（画素は同じ。書き出しと同じ設定で、絵によって 0〜6 割速い。ファイルは大きくなるが、撮った画像は保存しない） */
const FAST_PNG = { type: 'png', optimizeForSpeed: true };
/** これ以上の不透明度で「見えている」とする */
const VISIBLE_OPACITY = 0.5;
/** これ以上の不透明度で「出そろった」とし、コントラストを測る */
const SETTLED_OPACITY = 0.99;
const MIN_CONTRAST = 4.5;
/**
 * コントラストを測り直す間隔（秒）。一度測って足りていた文字は、位置・色・重なった面が変わらないあいだ、この間隔でだけ測り直す
 * （測るたびに画面全体を撮って展開するのが点検でいちばん重いため）。限界: 文字が動かないまま、後ろの背景だけがこれより短いあいだ明るさを変えると見逃す。
 */
const CONTRAST_RECHECK = 0.5;
/** 文字の箱同士の重なりを問題にする幅と高さ（px） */
const OVERLAP_PX = 4;
/**
 * 文字の上の形（cover）: 文字の箱のうち、形が手前にある割合がこれを超え、COVER_HIDDEN 未満なら「一部が隠れている」。
 * COVER_HIDDEN 以上は、板で文字を隠しておいて出す演出（隠れている間は見えていないものとして数える）とみなして問わない。
 */
const COVER_MIN = 0.1;
const COVER_HIDDEN = 0.9;
/** 文字の上の形: 一部が隠れたままこの秒数以上続いたら指摘する（転換で一瞬横切る形は問わない） */
const COVER_SECONDS = 0.2;
/** つなぎ目のちらつき: 背景でない画素の割合がこれ以下なら「背景だけ」、BLANK_BUSY 以上なら「絵がある」。色の差は BLANK_LEVELS を超えたら違う */
const BLANK_EMPTY = 0.002;
const BLANK_BUSY = 0.01;
/** つなぎ目のちらつき: 穴のあとの最初のコマの絵の濃さ（最初のコマからの増え）が、0.1 秒のコマのこの割合以上なら「一気に出そろった」（だんだん出る入場と分ける） */
const BLANK_SHARE = 0.8;
/** つなぎ目のちらつき: 空のコマが続いてもちらつきとみなす長さ（秒）。30fps の1コマ。60fps なら2コマの穴まで見る */
const BLANK_HOLE = 1 / 30;
const BLANK_LEVELS = 24;
/** つなぎ目のちらつき: 入場の進みを比べる「0.1 秒のコマ」の時刻（シーン内の秒。STEP とは別に撮る） */
const BLANK_EARLY = 0.1;
/**
 * 比率ごとの、画面の下の安全域（画面の高さに対する割合。motion-rules.md の「比率ごとの下の安全域」の表と同じ）。
 * ui は SNS のボタンや説明文が重なる場所で、字幕も含めてどの文字も入れない。subtitle はその上の、字幕のためにあける帯で、
 * 字幕のほかの文字（title、caption、label）を入れない。9:16 は SNS の縦型（ショート動画）で見られ、下 20% に各サービスの
 * ボタンや説明文が重なる。4:5 はフィードの投稿で見られ、ボタンは動画の外（下）に出るので、16:9 と同じにする。
 * @type {Record<string, {ui: number, subtitle: number}>}
 */
export const SAFE_BOTTOM = {
  '16:9': { ui: 0, subtitle: 0.1 },
  '1:1': { ui: 0, subtitle: 0.1 },
  '4:5': { ui: 0, subtitle: 0.1 },
  '9:16': { ui: 0.2, subtitle: 0.1 },
};

/** 割合を「10%」のように */
const pct = (r) => `${Math.round(r * 100)}%`;

/**
 * 文字の下の端（px、画面の上から）が、その比率の安全域に入っていれば、利用者に見せる文の後半を返す（入っていなければ null）。
 * @param {string} kind テキストの種類（title、caption、label、subtitle）
 * @param {number} bottom 文字の箱の下の端
 * @param {string} ratio
 * @returns {string|null}
 */
export function safeAreaMessage(kind, bottom, ratio) {
  const { ui, subtitle } = SAFE_BOTTOM[ratio];
  const height = RATIOS[ratio][1];
  const band = ui ? `下から ${Math.round(ui * 100)}〜${pct(ui + subtitle)}` : `下 ${pct(subtitle)}`;
  if (ui && bottom > height * (1 - ui) + 0.5) {
    return `画面の下 ${pct(ui)} に入っています。SNS ではここにボタンや説明文が重なるので、`
      + (kind === 'subtitle' ? `字幕はその上（${band} の帯）に置いてください。` : 'もっと上に置いてください。');
  }
  if (kind !== 'subtitle' && bottom > height * (1 - ui - subtitle) + 0.5) {
    return `画面の${band} の字幕用の場所に入っています。もう少し上に置いてください。`;
  }
  return null;
}
/**
 * 文字の行の箱が、背景の箱（枠線の内側）をこれより大きく越えたら、はみ出しとする（px）。
 * 小数の位置の丸めと、字の幅のわずかな揺れを許す幅。箱の余白（padding）に入るだけなら問わない
 * （余白を詰めた札や、角に寄せた文字は意図した形でありうる。余白の詰まり具合は人が見る）。
 */
const SPILL_PX = 1;
/** 背景を拾う、文字の箱の外周の幅（px） */
const RING = 2;
/** 決定論: 色の差がこれ（0〜255 の段階）を超えた画素を「違う」と数える */
const DET_LEVELS = 2;
/** 決定論: 違う画素がこの割合（全画素に対して）を超えたら、違う絵とする */
const DET_PIXELS = 0.0001;
/** 点滅: 平均輝度の変化がこの割合（0〜255 の幅に対して）を超えたら、明暗が入れ替わったとみなす */
const FLASH_CHANGE = 0.2;
/** 点滅: 1 秒あたりの上限（回） */
const MAX_FLASHES = 3;
const TARGET_LUFS = -14;
const LUFS_TOLERANCE = 1;
const MAX_TRUE_PEAK = -1;
/** ループ（完成版の MP4）: 圧縮の揺らぎを許す規則。PSNR（dB）がこれ未満なら絵が違う */
const LOOP_MIN_PSNR = 45;
/** ループ（完成版の MP4）: 8×8 の区画のどれかで、色の差の平均がこれ（0〜255 の段階）を超えたら絵が違う */
const LOOP_BLOCK = 8;
const LOOP_MAX_BLOCK_MAD = 6;

/**
 * @typedef {'script-error'|'overflow'|'safe-area'|'overlap'|'text-mismatch'|'hardcoded-text'|'contrast'
 *   |'cover'|'blank'|'hold'|'narration'|'flash'|'determinism'|'media'|'loudness'|'loop'} CheckId
 * @typedef {{check: CheckId, cut: number, t: number, message: string, evidence?: string, intent?: string[]}} Finding
 *   intent は、その指摘に関わる要素の data-ms-intent（祖先とシーンの body を含む）
 * @typedef {'build'|'final'} Stage
 * @typedef {{x: number, y: number, w: number, h: number}} Box
 * @typedef {{id: string|null, text: string, box: Box, full: Box, cut: boolean,
 *   spill: {over: number, glyph: Box, paint: Box} | null, parts?: Array<{cut: boolean, spill: {over: number, glyph: Box, paint: Box} | null} | null>,
 *   color: string, fontSize: number, opacity: number, index: number}} LayoutItem
 *   box はマスクで切った箱、full は見えている文字の切る前の箱、cut は文字の一部がマスクで隠れているか、
 *   spill は背景の箱を越える幅と、比べた2つの箱、parts は文字ノードごとの cut と spill（見えていない文字ノードは null。ms-runtime.js の visibleBox）
 */

const round3 = (x) => Math.round(x * 1000) / 1000;
/** started（Date.now()）からの秒数（小数1桁） */
const seconds = (started) => ((Date.now() - started) / 1000).toFixed(1);
/** 利用者に見せる文の頭（「カット3（0:05.2）: 」） */
const at = (cut, t) => `カット${cut}（${formatTime(t)}）: `;
/** 文の中に入れる文字（長ければ縮める） */
const quote = (s) => `「${[...s].length > 30 ? `${[...s].slice(0, 30).join('')}…` : s}」`;
const totalEnd = (tl) => tl.scenes[tl.scenes.length - 1].end;

/**
 * 前回のシーンの指摘を、シーンがずれた秒数だけずらす（時刻と、文の頭の「カット3（0:05.2）: 」。シーンの指摘の文はどれもこの頭で始まる）。
 * @template {Finding} F
 * @param {F} f
 * @param {number} delta
 * @returns {F}
 */
function shiftFinding(f, delta) {
  if (Math.abs(delta) < 1e-9) return f;
  const t = round3(f.t + delta);
  const head = at(f.cut, f.t);
  return { ...f, t, message: f.message.startsWith(head) ? at(f.cut, t) + f.message.slice(head.length) : f.message };
}

/**
 * 完成版の MP4 の場所。out/<題名>_<比率の : を x に>[_draft].mp4。題名のファイル名に使えない文字は _ にする。
 * @param {string} projectDir
 * @param {{title?: string}} tl
 * @param {string} ratio
 * @param {'draft'|'final'} preset
 */
export function videoPath(projectDir, tl, ratio, preset) {
  const title = (tl.title ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'video';
  return path.join(projectDir, 'out', `${title}_${ratioDir(ratio)}${preset === 'draft' ? '_draft' : ''}.mp4`);
}

/**
 * ループ版（loop が true のとき、全品質だけ）の場所。out/<題名>_<比率>_loop.mp4
 * @param {string} projectDir
 * @param {{title?: string}} tl
 * @param {string} ratio
 */
export const loopVideoPath = (projectDir, tl, ratio) => videoPath(projectDir, tl, ratio, 'final').replace(/\.mp4$/, '_loop.mp4');

// ---- 色と画素 ----

/** sRGB（0〜255）の相対輝度（WCAG） */
function luminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const ratioOf = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

/**
 * 2色のコントラスト比（WCAG、1〜21）。
 * @param {number[]} a [r, g, b]（0〜255）
 * @param {number[]} b
 */
export function contrastRatio(a, b) {
  return ratioOf(luminance(a), luminance(b));
}

/** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" を [r, g, b] に。読めない形なら null */
/**
 * 文字の色に、上に重なった半透明の面を下から順に重ねた色。
 * @param {number[]} rgb
 * @param {Array<{rgb: number[], a: number}>} veils
 */
export function veiled(rgb, veils) {
  return veils.reduce((c, v) => c.map((x, i) => x * (1 - v.a) + v.rgb[i] * v.a), rgb);
}

function parseColor(s) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * スクリーンショットの PNG（8bit、RGB か RGBA、インターレースなし）を画素に展開する。
 * @param {Buffer} buf
 * @returns {{width: number, height: number, channels: number, data: Buffer}}
 */
function decodePng(buf) {
  let pos = 8;
  let width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8], color = body[9], interlace = body[12];
      if (depth !== 8 || ![2, 6].includes(color) || interlace !== 0) throw new Error('この形式の PNG は読めません');
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[row + x - channels] : 0;
      const b = y > 0 ? data[row - stride + x] : 0;
      const c = x >= channels && y > 0 ? data[row - stride + x - channels] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[row + x] = v & 0xff;
    }
  }
  return { width, height, channels, data };
}

/**
 * 文字の箱のすぐ外（RING px の帯）の画素から、背景の輝度の中央値を求める。
 * 画面全体のスクリーンショットから切り出す（clip で撮ると、そのページのあとの描画が
 * わずかに変わり、決定論の点検が誤って引っかかることがあるため）。
 * @param {ReturnType<typeof decodePng>} png 画面全体
 * @returns {number|null} 帯が画面の外で拾えなければ null
 */
function ringLuminance(png, box) {
  const inner = { l: Math.floor(box.x), t: Math.floor(box.y), r: Math.ceil(box.x + box.w), b: Math.ceil(box.y + box.h) };
  const l = Math.max(0, inner.l - RING), t = Math.max(0, inner.t - RING);
  const r = Math.min(png.width, inner.r + RING), b = Math.min(png.height, inner.b + RING);
  const lums = [];
  for (let y = t; y < b; y++) {
    for (let x = l; x < r; x++) {
      if (x >= inner.l && x < inner.r && y >= inner.t && y < inner.b) continue;
      const i = (y * png.width + x) * png.channels;
      lums.push(luminance([png.data[i], png.data[i + 1], png.data[i + 2]]));
    }
  }
  if (lums.length === 0) return null;
  lums.sort((a, b2) => a - b2);
  return lums[Math.floor(lums.length / 2)];
}

/**
 * @typedef {{area: number, ink: number}} Fill コマの絵の量。area は背景でない画素の割合（0〜1）、
 *   ink は背景からの色の差（各画素の色の差の最大を 255 で割った値）の平均（0〜1。薄く現れている絵は小さい）
 */
/**
 * 画面の絵の量。4 画素おきに見る。背景の色は、各色を 16 段に丸めて一番多い組の平均とし、
 * area はその色から BLANK_LEVELS を超えて違う画素の割合、ink は色の差の平均。
 * @param {ReturnType<typeof decodePng>} png
 * @returns {Fill}
 */
export function fillAmount(png) {
  const { width, height, channels, data } = png;
  /** @type {Map<number, {n: number, r: number, g: number, b: number}>} */
  const buckets = new Map();
  const samples = [];
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      samples.push(r, g, b);
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const k = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      k.n++; k.r += r; k.g += g; k.b += b;
      buckets.set(key, k);
    }
  }
  const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  if (!top) return { area: 0, ink: 0 };
  const bg = [top.r / top.n, top.g / top.n, top.b / top.n];
  let other = 0, ink = 0;
  for (let j = 0; j < samples.length; j += 3) {
    const d = Math.max(Math.abs(samples[j] - bg[0]), Math.abs(samples[j + 1] - bg[1]), Math.abs(samples[j + 2] - bg[2]));
    if (d > BLANK_LEVELS) other++;
    ink += d / 255;
  }
  const n = samples.length / 3;
  return { area: other / n, ink: ink / n };
}

/**
 * つなぎ目のちらつき（blank）: カットの最初のコマが背景だけ（area が BLANK_EMPTY 以下）で、前のカットの最後のコマに絵があり
 * （area が BLANK_BUSY 以上）、空のコマのすぐ後のコマ（second。完成版の fps で、BLANK_HOLE 秒までの穴のあと）にもう絵が出そろっている
 * （area が BLANK_BUSY 以上、かつ ink の最初のコマからの増えが、0.1 秒のコマの増えの BLANK_SHARE 以上）とき、指摘を返す。
 * つまり「空のコマがはさまり、次のコマで絵がぱっと出る」ちらつき。何も無い地からフェードや拭き取りでだんだん出るふつうの入場は、
 * 穴のすぐ後にはまだ絵が薄いか狭い（ink が小さい）ので問わない。ink は最初のコマとの差で比べる（地の淡いグラデーションを数えない）。
 * 証拠（例外の鍵に入る）には、このカットのコマの値だけを入れる（隣のカットを直しただけで例外が外れないように）。
 * @param {Array<{first?: Fill, second?: Fill, early?: Fill, last?: Fill, intent?: string[]} | null | undefined>} fills シーンの並び順の、コマの絵の量
 *   （intent はそのシーンの body の data-ms-intent）
 * @param {import('./timeline.mjs').Timeline} tl
 * @returns {Finding[]}
 */
export function blankFindings(fills, tl) {
  /** @type {Finding[]} */
  const out = [];
  for (let i = 1; i < tl.scenes.length; i++) {
    const prev = fills[i - 1], cur = fills[i];
    if (!prev?.last || !cur?.first || !cur.second || !cur.early) continue;
    if (cur.first.area <= BLANK_EMPTY && prev.last.area >= BLANK_BUSY && cur.second.area >= BLANK_BUSY
      && cur.early.ink > cur.first.ink && cur.second.ink - cur.first.ink >= (cur.early.ink - cur.first.ink) * BLANK_SHARE) {
      const cut = i + 1, t = round3(tl.scenes[i].start);
      out.push({ check: 'blank', cut, t, ...(cur.intent?.length ? { intent: cur.intent } : {}),
        message: `${at(cut, t)}カットの最初のコマが背景だけで、前のカットの最後のコマにも、すぐ後のコマにも絵があります。つなぎ目で一瞬だけ画面が空になり、ちらついて見えます。`
          + '最初のコマから何かを置いてください（前のカットから引き継ぐ形、入場の途中まで出た形、地の色の面など。composition.md）。',
        evidence: `背景でない画素 最初のコマ ${(cur.first.area * 100).toFixed(1)}%、穴のすぐ後のコマ ${(cur.second.area * 100).toFixed(1)}%` });
    }
  }
  return out;
}

// ---- シーンの点検 ----

/** 2つの箱の重なり（幅と高さ） */
function intersection(a, b) {
  return {
    w: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
  };
}

/** 見本どおりかを比べるため、空白をそろえる */
const normalize = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * 2枚のスクリーンショットが同じ絵か。縁のなめらかにする処理のわずかな揺れは許す:
 * どれかの色が DET_LEVELS を超えて違う画素が、全体の DET_PIXELS を超えたら違う絵とする。
 * @param {Buffer} a PNG
 * @param {Buffer} b PNG
 */
export function sameFrame(a, b) {
  if (a.equals(b)) return true;
  return differingRatio(decodePng(a), decodePng(b)) <= DET_PIXELS;
}

/**
 * 2枚の画像（decodePng と同じ形）で、色の差が DET_LEVELS を超えた画素の割合（0〜1）。大きさが違えば 1。
 * 決定論とループの継ぎ目が同じ規則で比べるための共通部分。
 * @param {{width: number, height: number, channels: number, data: Uint8Array}} x
 * @param {{width: number, height: number, channels: number, data: Uint8Array}} y
 */
function differingRatio(x, y) {
  if (x.width !== y.width || x.height !== y.height) return 1;
  const total = x.width * x.height;
  let differ = 0;
  for (let p = 0; p < total; p++) {
    const i = p * x.channels, j = p * y.channels;
    if (Math.abs(x.data[i] - y.data[j]) > DET_LEVELS || Math.abs(x.data[i + 1] - y.data[j + 1]) > DET_LEVELS
      || Math.abs(x.data[i + 2] - y.data[j + 2]) > DET_LEVELS) differ++;
  }
  return differ / total;
}

/**
 * 決定論の点検。シーン内の時刻 t を、同じページで2回（あいだに手前の時刻を挟む）と、新しいページで1回描いて比べる。
 * Chrome は動いている層を、それまでに撮った中で一番大きい倍率で描き続けるため、先にあとの時刻を撮ったページと
 * 新しいページでは縁の画素がわずかに変わる。これは sameFrame の許容で吸収し、呼び出し側でも先に行う
 * （書き出しはいつも先頭から順に撮るので、動画には影響しない）。
 * @param {any} page 開いたシーンのページ
 * @param {() => Promise<any>} openFresh 同じシーンを新しく開く
 * @param {number} t
 * @returns {Promise<string[]>} 食い違いの説明（空なら一致）
 */
export async function determinismDiffs(page, openFresh, t) {
  const seek = (p, x) => p.evaluate((v) => window.__ms.seek(v), x);
  await seek(page, t);
  const first = await page.screenshot(FAST_PNG);
  await seek(page, round3(t / 2));
  await seek(page, t);
  const second = await page.screenshot(FAST_PNG);
  const p2 = await openFresh();
  let fresh;
  try {
    await seek(p2, t);
    fresh = await p2.screenshot(FAST_PNG);
  } finally {
    await p2.close().catch(() => {});
  }
  const diffs = [];
  if (!sameFrame(first, second)) diffs.push('同じページで描き直すと変わる');
  if (!sameFrame(second, fresh)) diffs.push('開き直して描くと変わる');
  return diffs;
}

/** シーン内で見る時刻: 0.2 秒刻みと、最後のフレーム */
function sampleTimes(scene, fps) {
  const duration = scene.end - scene.start;
  const times = [];
  for (let i = 0; i * STEP < duration - 1e-9; i++) times.push(round3(i * STEP));
  const { f0, frames } = sceneFrames(scene, fps);
  if (frames > 0) times.push(Math.max(0, frameTime(scene, fps, f0, frames - 1)));
  return [...new Set(times)].sort((a, b) => a - b);
}

/**
 * 1つのシーンを開いて点検する。
 * @param {any} browser
 * @param {{projectDir: string, tl: import('./timeline.mjs').Timeline, ratio: string, fps: number, seen: Set<string>,
 *   loopShots: {first?: Buffer, last?: Buffer, t?: number} | null, fills?: {first?: Fill, second?: Fill, early?: Fill, last?: Fill, intent?: string[]},
 *   intentsSeen?: Array<{scene: string, checks: string[]}>, stats?: {samples: number, shots: number}}} ctx
 *   seen は報告済みの鍵（同じ文字の同じ不具合を、時刻ごとに何件も出さない）。
 *   stats を渡すと、見た時刻の数と撮った画面の数を足す（途中の様子の記録に出す）。
 *   loopShots を渡すと、動画の最初と最後のコマの PNG と、最後のコマの時刻を入れる。
 *   fills を渡すと、シーンの最初のコマ・穴のすぐ後のコマ・0.1 秒のコマ・最後のコマの絵の量（fillAmount）を入れる（つなぎ目のちらつきの点検に使う）
 * @param {number} index シーンの並び順（0 始まり）
 *   intentsSeen を渡すと、シーンの data-ms-intent の宣言（使える名前だけ）を入れる
 * @param {(f: Finding, key: string) => void} reportFinding
 */
async function checkScene(browser, { projectDir, tl, ratio, fps, seen, loopShots, fills, intentsSeen, stats = { samples: 0, shots: 0 } }, index, reportFinding) {
  const scene = tl.scenes[index];
  const cut = index + 1;
  const [width, height] = RATIOS[ratio];
  const spec = { width, height, scale: 1 };
  const texts = new Map(tl.texts.filter((x) => x.scene === scene.id).map((x) => [x.id, x]));
  let local = 0;
  const abs = () => round3(scene.start + local);
  /** シーンの body の data-ms-intent（使える名前だけ）。シーンのすべての指摘に効く */
  let rootIntent = [];
  const report = (f, key) => reportFinding(rootIntent.length ? { ...f, intent: [...new Set([...(f.intent ?? []), ...rootIntent])] } : f, key);
  /** 2つの宣言を合わせる（空なら intent を付けない） */
  const withIntent = (...lists) => {
    const all = [...new Set(lists.flatMap((x) => x ?? []))];
    return all.length ? { intent: all } : {};
  };
  /** @type {Map<string, string[]>} 文字の id ごとの data-ms-intent（見えたときの値） */
  const idIntent = new Map();

  const scriptError = (detail) => report({
    check: 'script-error', cut, t: abs(),
    message: `${at(cut, abs())}シーンの描画プログラムでエラーが起きました（${detail}）。`,
    evidence: scene.file ?? `src/scenes/${scene.id}.html`,
  }, `script-error|${cut}|${detail}`);
  const listen = (page) => {
    page.on('pageerror', (e) => scriptError(e instanceof Error ? e.message : String(e)));
    page.on('console', (m) => { if (m.type() === 'error') scriptError(m.text()); });
  };

  let page;
  try {
    page = await openPage(browser, projectDir, scene.id, ratio, spec, { onPage: listen });
  } catch (e) {
    scriptError(e.message);
    return;
  }
  const seek = async (t) => {
    local = t;
    await page.evaluate((x) => window.__ms.seek(x), t);
  };
  /** 画面を撮る（撮った数を数える） */
  const shoot = () => {
    stats.shots++;
    return page.screenshot(FAST_PNG);
  };
  try {
    // 宣言の名前を確かめる。知らない名前や、正しく作るための点検の名前は、黙って無視せずに知らせる
    const declared = await page.evaluate(() => window.__ms.intents?.() ?? { root: [], all: [] });
    const bad = declared.all.filter((w) => !ELEMENT_INTENT_CHECKS.includes(w));
    if (bad.length) {
      const whole = bad.filter((w) => INTENT_CHECKS.includes(w));
      reportFinding({ check: 'script-error', cut, t: abs(),
        message: `${at(cut, abs())}data-ms-intent に使えない名前があります: ${bad.join('、')}（要素に書けるのは ${ELEMENT_INTENT_CHECKS.join('、')}。`
          + (whole.length ? `${whole.join('、')} は動画全体かシーン単位で見る点検なので、要素ではなく project.mjs intent で宣言してください。` : '')
          + '原稿との食い違い・直書き・決定論・描画のエラーは外せません）。',
        evidence: scene.file ?? `src/scenes/${scene.id}.html` },
      `script-error|${cut}|intent`);
    }
    rootIntent = declared.root.filter((w) => ELEMENT_INTENT_CHECKS.includes(w));
    if (fills && rootIntent.length) fills.intent = rootIntent;
    intentsSeen?.push({ scene: scene.id, checks: declared.all.filter((w) => ELEMENT_INTENT_CHECKS.includes(w)), counts: declared.counts ?? {} });

    // 決定論は文字の点検より先に見る（あとの時刻を撮る前のほうが、新しいページと条件がそろう。determinismDiffs の説明）
    const center = round3((scene.end - scene.start) / 2);
    let diffs;
    try {
      local = center;
      diffs = await determinismDiffs(page, () => openPage(browser, projectDir, scene.id, ratio, spec), center);
      stats.shots += 3;
    } catch (e) {
      scriptError(e.message);
      return;
    }
    if (diffs.length > 0) {
      report({ check: 'determinism', cut, t: abs(),
        message: `${at(cut, abs())}同じ時刻を描くたびに絵が変わります。時計や前のフレームの状態に頼らず、時刻 t だけから描いてください。`,
        evidence: diffs.join('、') },
      `determinism|${cut}`);
    }

    const times = sampleTimes(scene, fps);
    stats.samples += times.length;
    /** @type {Map<string, number[]>} id ごとに、見えていたシーン内の時刻 */
    const shown = new Map();
    // 切れたまま・はみ出したままは、文字ノードごと（LayoutItem の parts の番号）に数える。語や文節ごとの span を順に出す見出しでは、
    // 先に出た語だけが見えている時刻に「切れずに見えた」と数えると、あとから出る行が切れたままでも見逃すため
    /** @type {Map<string, Map<number, {t: number, evidence: string} | null>>} id と文字ノードごとに、切れて見えた最初の時刻（切れずに見えたことがあれば null） */
    const cutOff = new Map();
    /** @type {Map<string, Map<number, {t: number, evidence: string} | null>>} id と文字ノードごとに、背景の箱からはみ出して見えた最初の時刻（全部見えて収まったことがあれば null） */
    const spilled = new Map();
    const nodeMap = (m, id) => m.get(id) ?? m.set(id, new Map()).get(id);
    /** @type {Map<string, {from: number, frac: number, by: string|null}>} id ごとに、形が文字の一部を隠し始めた時刻（続いている間だけ） */
    const coverRun = new Map();
    /** @type {Map<string, {t: number, sig: string}>} 文字（id か文字そのもの）ごとに、最後にコントラストを測って足りていた時刻と、そのときの位置・色・重なった面 */
    const contrastOk = new Map();
    for (const [k, t] of times.entries()) {
      try {
        await seek(t);
      } catch (e) {
        scriptError(e.message);
        return;
      }
      // ループの点検用に、動画の最初と最後のコマを撮っておく
      if (loopShots && index === 0 && k === 0) loopShots.first = await shoot();
      if (loopShots && index === tl.scenes.length - 1 && k === times.length - 1) {
        loopShots.last = await shoot();
        loopShots.t = abs();
      }
      /** @type {ReturnType<typeof decodePng> | null} この時刻の画面（要るときだけ撮る） */
      let shot = null;
      // つなぎ目のちらつきの点検用に、最初のコマ・穴のすぐ後のコマ・0.1 秒のコマ・最後のコマの絵の量を測る
      const marks = fills ? [k === 0 && 'first', k === times.length - 1 && 'last'].filter(Boolean) : [];
      if (k === 0 && fills && times.length > 1) {
        // 穴のすぐ後のコマは、点検の fps（ラフ版は 30）ではなく、完成版の fps で見る（ちらつきは完成版のコマで起きる）。
        // 2コマ目がまだ空なら、BLANK_HOLE 秒（60fps なら2コマ）までの穴として、その次のコマも見る
        const { f0 } = sceneFrames(scene, tl.fps);
        const hole = Math.max(1, Math.round(BLANK_HOLE * tl.fps));
        try {
          for (let n = 1; n <= hole; n++) {
            await seek(Math.max(0, frameTime(scene, tl.fps, f0, n)));
            fills.second = fillAmount(decodePng(await shoot()));
            if (fills.second.area > BLANK_EMPTY) break;
          }
          // 0.1 秒のコマ（入場の進みの目安）。見る間隔とは別に撮る
          await seek(Math.min(BLANK_EARLY, times[times.length - 1]));
          fills.early = fillAmount(decodePng(await shoot()));
          await seek(t);
        } catch (e) {
          scriptError(e.message);
          return;
        }
      }
      if (marks.length) {
        shot = decodePng(await shoot());
        const v = fillAmount(shot);
        for (const m of marks) fills[m] = v;
      }
      /** @type {LayoutItem[]} */
      const items = (await page.evaluate(() => window.__ms.layout())).filter((x) => x.opacity >= VISIBLE_OPACITY);
      // 文字の上に重なった面（下から順）。不透明な板の下に隠れた文字は、見えていないものとして数える
      /** @type {Map<LayoutItem, Array<{rgb: number[], a: number}>>} */
      const veilOf = new Map();
      if (items.length) {
        const vs = await page.evaluate((ix) => window.__ms.veils(ix), items.map((x) => x.index));
        for (const [j, x] of items.entries()) veilOf.set(x, vs[j] ?? []);
      }
      const covered = (x) => (veilOf.get(x) ?? []).some((v) => v.a >= SETTLED_OPACITY);
      for (const x of items) if (x.id && !covered(x)) shown.set(x.id, [...(shown.get(x.id) ?? []), t]);
      const now = abs();
      // 文字の上に描いた形（図形・面・画像）が、文字の一部を隠したまま COVER_SECONDS 以上続いたら指摘する
      const named = items.filter((x) => x.id);
      const over = named.length ? await page.evaluate((ix) => window.__ms.covers(ix), named.map((x) => x.index)) : [];
      const hiddenNow = new Set();
      for (const [j, x] of named.entries()) {
        const c = over[j];
        if (!c || c.frac <= COVER_MIN || c.frac >= COVER_HIDDEN) continue;
        hiddenNow.add(x.id);
        const run = coverRun.get(x.id) ?? { from: now, frac: 0, by: c.by, byIntent: c.byIntent };
        if (c.frac > run.frac) Object.assign(run, { frac: c.frac, by: c.by, byIntent: c.byIntent });
        coverRun.set(x.id, run);
        if (now - run.from >= COVER_SECONDS - 1e-9) {
          report({ check: 'cover', cut, t: run.from, ...withIntent(x.intent, run.byIntent),
            message: `${at(cut, run.from)}文字${quote(x.text)}の上に、形（${run.by}）が重なっています（${round3(now - run.from)} 秒以上、文字の一部が隠れたまま）。`
              + '形を文字の箱の外で動かすか、文字より後ろ（重なり順で下）に回してください。転換の拭き取りのように、わざと文字の上を通す形には data-ms-wipe を付けてください。',
            evidence: `隠れた割合 ${pct(run.frac)}（文字の箱に置いた点のうち、形が手前にある点）` },
          `cover|${cut}|${x.id}`);
        }
      }
      // 隠れていない時刻をはさんだら、続いた時間を数え直す
      for (const id of [...coverRun.keys()]) if (!hiddenNow.has(id)) coverRun.delete(id);
      for (const x of items) if (x.id && x.intent?.length) idIntent.set(x.id, x.intent);
      for (const x of items) {
        if (!x.id) continue;
        const { box, full } = x;
        const cuts = nodeMap(cutOff, x.id);
        for (const [k, part] of (x.parts ?? []).entries()) {
          if (!part || cuts.get(k) === null) continue;
          if (!part.cut) cuts.set(k, null);
          else if (!cuts.has(k)) {
            cuts.set(k, { t: now, evidence: `見えている部分 x=${box.x} y=${box.y} 幅=${box.w} 高さ=${box.h}、文字全体 x=${full.x} y=${full.y} 幅=${full.w} 高さ=${full.h}` });
          }
        }
      }
      // 入場の途中（滑り込み・拭き取り）のはみ出しは問わないため、一度でも全部見えて収まれば null にする
      for (const x of items) {
        if (!x.id) continue;
        const spills = nodeMap(spilled, x.id);
        for (const [k, part] of (x.parts ?? []).entries()) {
          if (!part?.spill || spills.get(k) === null) continue;
          const { over, glyph: g, paint: p } = part.spill;
          if (over <= SPILL_PX) {
            if (!part.cut) spills.set(k, null);
          } else if (!spills.has(k)) {
            spills.set(k, { t: now, evidence: `文字 x=${g.x} y=${g.y} 幅=${g.w} 高さ=${g.h}、背景の箱 x=${p.x} y=${p.y} 幅=${p.w} 高さ=${p.h}、はみ出し ${over}px` });
          }
        }
      }
      const head = at(cut, now);
      const subject = (x) => x.id ?? x.text;
      for (const x of items) {
        const box = x.full;
        const name = quote(x.text);
        const where = `x=${box.x} y=${box.y} 幅=${box.w} 高さ=${box.h}`;
        if (box.x < -0.5 || box.y < -0.5 || box.x + box.w > width + 0.5 || box.y + box.h > height + 0.5) {
          report({ check: 'overflow', cut, t: now, message: `${head}文字${name}が画面の外にはみ出しています。`, evidence: where, ...withIntent(x.intent) },
            `overflow|${cut}|${subject(x)}`);
        }
        const kind = x.id ? texts.get(x.id)?.kind : undefined;
        const safe = kind ? safeAreaMessage(kind, box.y + box.h, ratio) : null;
        if (safe) report({ check: 'safe-area', cut, t: now, message: `${head}文字${name}が、${safe}`, evidence: where, ...withIntent(x.intent) }, `safe-area|${cut}|${subject(x)}`);
        if (x.id === null) {
          report({ check: 'hardcoded-text', cut, t: now,
            message: `${head}文字${name}が原稿（timeline.json）にありません。原稿に足して、そこから表示してください。` },
          `hardcoded-text|${cut}|${x.text}`);
        } else {
          // ほかのカットの原稿の番号を使っていても、食い違いとする
          const want = texts.get(x.id);
          if (!want || normalize(want.text) !== normalize(x.text)) {
            report({ check: 'text-mismatch', cut, t: now,
              message: want
                ? `${head}画面の文字${name}が原稿（${x.id}${quote(want.text)}）と違います。`
                : `${head}画面の文字${name}の番号 ${x.id} は、このカットの原稿にありません。`,
              evidence: x.id },
            `text-mismatch|${cut}|${x.id}`);
          }
        }
      }
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const o = intersection(items[i].box, items[j].box);
          if (o.w >= OVERLAP_PX && o.h >= OVERLAP_PX) {
            report({ check: 'overlap', cut, t: now, ...withIntent(items[i].intent, items[j].intent),
              message: `${head}文字${quote(items[i].text)}と${quote(items[j].text)}が重なっています。`,
              evidence: `重なり 幅=${round3(o.w)} 高さ=${round3(o.h)}` },
            `overlap|${cut}|${subject(items[i])}|${subject(items[j])}`);
          }
        }
      }
      const judged = items.filter((x) => x.opacity >= SETTLED_OPACITY && !seen.has(`contrast|${cut}|${subject(x)}`) && parseColor(x.color));
      // 文字の上に重ねた半透明の面（操作箇所の外を暗くする面など）は、文字の色にも重ねて比べる
      for (const x of judged) {
        // 不透明な板の下に隠れた文字は見えていないので、読みにくさは問わない（ずっと隠れていれば、一度も表示されていないと指摘する）
        if (covered(x)) continue;
        const vs = veilOf.get(x) ?? [];
        const sig = JSON.stringify([x.box, x.color, vs]);
        const ok = contrastOk.get(subject(x));
        if (ok && ok.sig === sig && t - ok.t < CONTRAST_RECHECK - 1e-9) continue;
        const color = veiled(parseColor(x.color), vs);
        shot ??= decodePng(await shoot());
        const bg = ringLuminance(shot, x.box);
        if (bg === null) continue;
        const c = ratioOf(luminance(color), bg);
        if (c >= MIN_CONTRAST) contrastOk.set(subject(x), { t, sig });
        else {
          report({ check: 'contrast', cut, t: now, ...withIntent(x.intent),
            message: `${head}文字${quote(x.text)}と背景の明るさの差が小さく、読みにくくなっています（コントラスト ${c.toFixed(1)}。${MIN_CONTRAST} 以上にしてください）。`,
            evidence: `文字色 ${x.color}${vs.length ? `（重なった面を足すと rgb(${color.map(Math.round).join(", ")})）` : ""}、背景の輝度 ${bg.toFixed(3)}` },
          `contrast|${cut}|${subject(x)}`);
        }
      }
    }

    // 表示のあいだずっと、一部がマスクに隠れたままの文字（小さすぎる箱で切れている）
    /** 文字ノードのうち、ずっと切れたまま（はみ出したまま）のものの、いちばん早い記録 */
    const firstOpen = (nodes) => [...nodes.values()].filter(Boolean).sort((a, b) => a.t - b.t)[0];
    for (const [id, nodes] of cutOff) {
      const c = firstOpen(nodes);
      if (!c) continue;
      const x = texts.get(id);
      report({ check: 'overflow', cut, t: c.t, ...withIntent(idIntent.get(id)),
        message: `${at(cut, c.t)}テロップ ${id}${quote(x?.text ?? '')}の一部が、表示のあいだずっと隠れたままです（入れ物の箱が小さく、文字が切れています）。箱を広げるか、文字を短くしてください。`,
        evidence: c.evidence },
      `overflow|${cut}|${id}`);
    }

    // 表示のあいだずっと、背景の箱（行や札）からはみ出したままの文字
    for (const [id, nodes] of spilled) {
      const c = firstOpen(nodes);
      if (!c) continue;
      const x = texts.get(id);
      report({ check: 'overflow', cut, t: c.t, ...withIntent(idIntent.get(id)),
        message: `${at(cut, c.t)}テロップ ${id}${quote(x?.text ?? '')}が、表示のあいだずっと、背景の箱からはみ出しています（文字が箱の端を越えています）。箱を広げるか、文字を小さくするか短くしてください。`,
        evidence: c.evidence },
      `overflow-box|${cut}|${id}`);
    }

    // 原稿の文字が、出ているはずの区間（前後に 1 回分の余裕）で一度も見えなかった（画面の外に置いた、不透明な板の下にずっと隠れていたなど）
    for (const x of texts.values()) {
      const from = x.start - scene.start - STEP - 1e-9, to = x.end - scene.start + STEP + 1e-9;
      if ((shown.get(x.id) ?? []).some((t) => t >= from && t <= to)) continue;
      report({ check: 'overflow', cut, t: x.start,
        message: `${at(cut, x.start)}テロップ ${x.id}${quote(x.text)}が画面に一度も表示されていません。画面の中に、はっきり見えるように置いてください（不透明な板の下に隠れていないかも確かめてください）。`,
        evidence: x.id },
      `overflow|${cut}|${x.id}`);
    }
  } catch (e) {
    scriptError(e.message);
  } finally {
    await page.close().catch(() => {});
  }
}

// ---- 完成版の点検 ----

/** ffmpeg / ffprobe を実行する。失敗したら例外 */
function run(bin, args, { binary = false } = {}) {
  const r = spawnSync(bin, args, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new Error(`${path.basename(bin)} を実行できません: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${path.basename(bin)} が失敗しました: ${String(r.stderr).trim().slice(-500)}`);
  return r;
}

/**
 * 平均輝度の列から、1 秒の窓に MAX_FLASHES 回を超える点滅がある場所を返す。
 * 明暗の入れ替わり = 直前の山（谷）から FLASH_CHANGE を超えて逆向きに動いたこと。点滅1回 = 逆向きの入れ替わり2回。
 * @param {number[]} values フレームごとの平均輝度（0〜255）
 * @param {number} fps
 * @returns {Array<{frame: number, count: number}>} 窓の先頭のフレームと、その窓の点滅の回数（重ならない窓ごとに1件）
 */
export function flashes(values, fps) {
  const th = FLASH_CHANGE * 255;
  /** @type {number[]} 入れ替わりのフレーム */
  const turns = [];
  let dir = 0;
  let lo = values[0], hi = values[0];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (dir === 0) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      if (v - lo > th) { dir = 1; hi = v; turns.push(i); }
      else if (hi - v > th) { dir = -1; lo = v; turns.push(i); }
    } else if (dir === 1) {
      hi = Math.max(hi, v);
      if (hi - v > th) { dir = -1; lo = v; turns.push(i); }
    } else {
      lo = Math.min(lo, v);
      if (v - lo > th) { dir = 1; hi = v; turns.push(i); }
    }
  }
  const out = [];
  for (let j = 0; j < turns.length; j++) {
    let k = j;
    while (k < turns.length && turns[k] < turns[j] + fps) k++;
    const count = Math.floor((k - j) / 2);
    if (count > MAX_FLASHES) {
      out.push({ frame: turns[j], count });
      j = k - 1; // 次は、この窓のあとから探す
    }
  }
  return out;
}

/**
 * 先頭と末尾のコマの違う画素の割合（決定論と同じ規則）が上限を超えていたら loop の指摘を返す。
 * @param {number} ratio 違う画素の割合（0〜1）
 * @param {number} cut 最後のカット
 * @param {number} t 最後のコマの時刻
 * @returns {Finding|null}
 */
function loopFinding(ratio, cut, t) {
  if (ratio <= DET_PIXELS) return null;
  return loopIssue(cut, t, `違う画素 ${(ratio * 100).toFixed(3)}%（上限 ${DET_PIXELS * 100}%）`);
}

/** @returns {Finding} */
function loopIssue(cut, t, evidence, where = '') {
  return { check: 'loop', cut, t,
    message: `${at(cut, t)}${where}最後のコマと最初のコマの絵が違うため、繰り返し再生するとつなぎ目で絵が飛びます。最後を最初の絵に戻してください。`,
    evidence };
}

/**
 * 完成版（圧縮した MP4）の先頭と末尾のコマを、圧縮の揺らぎを許して比べる。
 * 元の絵が同じでも圧縮で画素が少し変わるので、画素ごとの規則は使わない。
 * PSNR が LOOP_MIN_PSNR 未満、または 8×8 の区画のどれかで色の差の平均が LOOP_MAX_BLOCK_MAD を超えたら違う絵とする
 * （細い線や縁が残っていれば区画の平均が大きくなる。圧縮のノイズは全体に薄く散るので区画の平均は小さい）。
 * @param {{width: number, height: number, channels: number, data: Uint8Array}} x
 * @param {{width: number, height: number, channels: number, data: Uint8Array}} y
 * @returns {{psnr: number, maxBlock: number}}
 */
export function codecDiff(x, y) {
  const { width: w, height: h, channels: ch } = x;
  let se = 0;
  let maxBlock = 0;
  for (let by = 0; by < h; by += LOOP_BLOCK) {
    for (let bx = 0; bx < w; bx += LOOP_BLOCK) {
      let sum = 0, n = 0;
      for (let yy = by; yy < Math.min(h, by + LOOP_BLOCK); yy++) {
        for (let xx = bx; xx < Math.min(w, bx + LOOP_BLOCK); xx++) {
          const i = (yy * w + xx) * ch;
          for (let k = 0; k < 3; k++) { const d = Math.abs(x.data[i + k] - y.data[i + k]); sum += d; se += d * d; n++; }
        }
      }
      maxBlock = Math.max(maxBlock, sum / n);
    }
  }
  const mse = se / (w * h * 3);
  return { psnr: mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse), maxBlock };
}

/** 分数の文字列（"30000/1001"）を数に */
const fraction = (s) => {
  const [a, b] = String(s).split('/').map(Number);
  return b ? a / b : a;
};

/**
 * 完成版の MP4 を点検する（media、flash、loudness、loop）。
 * loopCopy はループ版（本編と同じシーンの MP4 を音なしでつないだ複製）の点検で、尺・解像度・fps・音が無いこと・継ぎ目を見る
 * （点滅は本編と同じ絵なので本編で見る）。
 * @param {string} file
 * @param {import('./timeline.mjs').Timeline} tl
 * @param {{ratio: string, preset: 'draft'|'final', loopCopy?: boolean}} opts
 * @returns {Promise<Finding[]>}
 */
export async function checkVideo(file, tl, { ratio, preset, loopCopy = false }) {
  checkArgs(ratio, preset);
  const spec = outputSpec(tl, ratio, preset);
  const end = totalEnd(tl);
  const lastCut = tl.scenes.length;
  /** @type {Finding[]} */
  const out = [];
  const scope = loopCopy ? 'ループ版' : '動画全体';
  const what = loopCopy ? 'ループ版の' : '';
  // id は問題ごとに分ける（例外と止め時で、別の問題を同じものと数えないため）。ループ版は loop-copy| を前に付ける
  const idOf = (name) => `${loopCopy ? 'loop-copy|' : ''}${name}`;
  const whole = (check, name, message, evidence) => out.push({ check, cut: 1, t: 0, message: `${at(1, 0)}（${scope}）${message}`, evidence, id: idOf(`${check}|${name}`) });

  const probe = JSON.parse(run(ffprobePath(), ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate,duration:format=duration',
    '-of', 'json', file]).stdout);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const hasAudio = probe.streams.some((s) => s.codec_type === 'audio');
  if (!video) {
    whole('media', 'no-video', `${loopCopy ? 'ループ版' : '動画'}に映像が入っていません。`, file);
    return out;
  }
  if (video.width !== spec.outWidth || video.height !== spec.outHeight) {
    whole('media', 'resolution', `${what}解像度が ${video.width}×${video.height} です（${spec.outWidth}×${spec.outHeight} のはず）。`, file);
  }
  const fps = fraction(video.r_frame_rate);
  if (Math.abs(fps - spec.fps) > 0.01) whole('media', 'fps', `${what}fps が ${round3(fps)} です（${spec.fps} fps のはず）。`, file);
  // 映像の尺が無い入れ物もあるので、そのときはファイル全体の尺を使う
  let duration = Number(video.duration);
  if (!Number.isFinite(duration)) duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration)) {
    whole('media', 'duration-unreadable', `${what}尺を読み取れません。書き出し直してください。`, file);
  } else if (!(Math.abs(duration - end) <= 1 / spec.fps + 1e-3)) {
    out.push({ check: 'media', cut: lastCut, t: end,
      message: `${at(lastCut, Math.max(0, end - 1 / spec.fps))}（${scope}）${what}尺が ${round3(duration)} 秒です（${round3(end)} 秒のはず）。`, evidence: file, id: idOf('media|duration') });
  }

  if (loopCopy && hasAudio) whole('media', 'loop-audio', 'ループ版に音が入っています。音なしで書き出し直してください。', file);

  // 点滅: フレームごとの平均輝度（signalstats の YAVG）。縮めてから測る（平均はほぼ変わらず、速い）。ループ版は本編と同じ絵なので見ない
  const stats = loopCopy ? '' : run(ffmpegPath(), ['-hide_banner', '-nostats', '-i', file, '-an',
    '-vf', 'scale=320:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']).stdout;
  const yavg = [...stats.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  for (const h of flashes(yavg, fps)) {
    const t = round3(h.frame / fps);
    const { cut } = cutOf(tl, t);
    out.push({ check: 'flash', cut, t,
      message: `${at(cut, t)}1 秒の間に明るさが ${h.count} 回点滅しています。体調を崩す人がいるので、毎秒 ${MAX_FLASHES} 回以下にしてください。`,
      evidence: `YAVG の変化が ${FLASH_CHANGE * 100}% を超える入れ替わりを数えた`, id: idOf(`flash|${cut}|${t}`) });
  }

  if (hasAudio && !loopCopy) {
    // 音のミックス（mix.mjs）と同じ測り方（ebur128）で測る
    const { i: lufs, tp } = measureLoudness(file);
    const evidence = `統合 ${Number.isFinite(lufs) ? lufs.toFixed(2) : '-inf'} LUFS、トゥルーピーク ${Number.isFinite(tp) ? tp.toFixed(2) : '-inf'} dBTP（ebur128）`;
    // 効果音だけ（ナレーションも BGM も無い）なら持ち上げないので、-14 LUFS 以下であればよい
    const sfxOnly = !hasVoiceOrMusic(tl);
    if (sfxOnly) {
      if (Number.isFinite(lufs) && lufs > TARGET_LUFS) {
        whole('loudness', 'lufs', `効果音だけの動画なのに ${lufs.toFixed(1)} LUFS あります。${TARGET_LUFS} LUFS 以下にしてください。`, evidence);
      }
    } else if (!Number.isFinite(lufs) || Math.abs(lufs - TARGET_LUFS) > LUFS_TOLERANCE) {
      whole('loudness', 'lufs', Number.isFinite(lufs)
        ? `音の大きさが ${lufs.toFixed(1)} LUFS です。${TARGET_LUFS} LUFS（±${LUFS_TOLERANCE}）にそろえてください。`
        : 'ほとんど音が聞こえません。', evidence);
    }
    if (Number.isFinite(tp) && tp > MAX_TRUE_PEAK) {
      whole('loudness', 'true-peak', `音の一番大きいところが ${tp.toFixed(1)} dBTP で、割れるおそれがあります。${MAX_TRUE_PEAK} dBTP 以下にしてください。`, evidence);
    }
  }

  // 尺や解像度が合っていない動画では、先頭と末尾の比べようがないので見ない
  if (tl.loop && !out.some((f) => f.check === 'media')) {
    // 最初のコマと最後のコマを元の大きさのまま取り出す（最後は終わりの 0.1 秒だけ読んで末尾の1コマを取る）
    const size = spec.outWidth * spec.outHeight * 3;
    const grab = (inArgs, outArgs) => run(ffmpegPath(), ['-hide_banner', '-nostats', ...inArgs, '-i', file, '-an', ...outArgs,
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { binary: true }).stdout;
    const head = grab([], ['-frames:v', '1']);
    const tail = grab(['-sseof', '-0.1'], []);
    const frames = Math.floor(tail.length / size);
    if (head.length >= size && frames >= 1) {
      const img = (buf, off) => ({ width: spec.outWidth, height: spec.outHeight, channels: 3, data: buf.subarray(off, off + size) });
      const { psnr, maxBlock } = codecDiff(img(head, 0), img(tail, (frames - 1) * size));
      if (psnr < LOOP_MIN_PSNR || maxBlock > LOOP_MAX_BLOCK_MAD) {
        out.push({ ...loopIssue(lastCut, round3(end - 1 / spec.fps),
          `PSNR ${psnr.toFixed(1)} dB（下限 ${LOOP_MIN_PSNR}）、8×8 区画の差の平均の最大 ${maxBlock.toFixed(1)}（上限 ${LOOP_MAX_BLOCK_MAD}）`,
          loopCopy ? 'ループ版の' : ''), id: idOf('loop|seam') });
      }
    }
  }
  return out;
}

// ---- まとめ ----

/**
 * timeline.json だけで分かる指摘（ブラウザを使わない）。文字の表示時間の不足（hold）と、ナレーションの声の重なり（narration）。
 * @param {import('./timeline.mjs').Timeline} tl
 * @returns {Finding[]}
 */
export function timelineFindings(tl) {
  /** @type {Finding[]} */
  const out = [];
  const sceneIndex = new Map(tl.scenes.map((s, i) => [s.id, i]));
  const textById = new Map(tl.texts.map((x) => [x.id, x]));
  for (const h of holdViolations(tl)) {
    const x = textById.get(h.id);
    const cut = sceneIndex.get(x.scene) + 1;
    out.push({ check: 'hold', cut, t: x.start,
      message: `${at(cut, x.start)}文字${quote(x.text)}の表示が ${round3(h.actual)} 秒しかありません。読み切るには ${h.need} 秒以上出してください。${holdHint(h)}`,
      evidence: h.id });
  }
  // 声の重なりは、あとから始まる行のカットと時刻で示す（そこで声がかぶる）
  const lineById = new Map((tl.narration ?? []).map((n) => [n.id, n]));
  for (const o of narrationOverlaps(tl)) {
    const cut = sceneIndex.get(lineById.get(o.next).scene) + 1;
    out.push({ check: 'narration', cut, t: o.nextStart, message: `${at(cut, o.nextStart)}${overlapMessage(o)}。`, evidence: `${o.id},${o.next}` });
  }
  return out;
}

/** 前回の結果として残さない点検（一度きりのことでも出る） */
const UNCACHED_CHECKS = new Set(['script-error', 'determinism']);

/** @type {string|undefined} */
let checkerVersionCache;
/** 点検の結果を決めるプログラム（点検、シーンの開き方、原稿の切り出し、ランタイム） */
const CHECKER_SOURCES = ['./check.mjs', './render.mjs', './scene-page.mjs', './timeline.mjs', './runtime/ms-runtime.js'];

/** 点検のしかたの版（CHECKER_SOURCES の中身の sha256）。点検を変えたら、前回の結果を使わずに開き直すため */
function checkerVersion() {
  if (!checkerVersionCache) {
    const hash = crypto.createHash('sha256');
    for (const f of CHECKER_SOURCES) hash.update(`\0${f}\0`).update(fs.readFileSync(fileURLToPath(new URL(f, import.meta.url))));
    checkerVersionCache = hash.digest('hex');
  }
  return checkerVersionCache;
}

/**
 * 1つの比率のシーンと完成版の MP4 を点検する（timeline.json だけで分かる指摘は含めない）。
 * 指摘の id は、同じ不具合を見分ける鍵（直しても残っているかを数えるのに使う）。
 * シーンの点検は、鍵（ページの中身の鍵 pageHash、カットの番号、点検の版、コマの格子とのずれ）が前回と同じなら開き直さず、前回の指摘を使う
 * （reviews/.check-cache/<比率>.json。下書きと完成版で共通）。前のシーンの尺が変わって後ろへずれただけのシーンも開き直さず、
 * 指摘の時刻をずらして使う。ループの継ぎ目は、最初か最後のシーンが変わったら両方を開いて見直す。
 * @param {() => Promise<any>} getBrowser 開き直すシーンがあるときだけ呼ぶ（全部前回のままなら起動しない）
 * 開いて点検したシーンごとに、見た時刻の数・撮った画面の数・かかった秒数を log に出す（out/progress.log）。
 * @param {{projectDir: string, tl: import('./timeline.mjs').Timeline, ratio: string, preset: 'draft'|'final', stage: Stage, checker: string,
 *   log?: (line: string) => void}} ctx
 * @returns {Promise<Finding[]>}
 */
async function checkRatio(getBrowser, { projectDir, tl, ratio: r, preset: p, stage, checker, intentsSeen, log = () => {} }) {
  /** @type {Finding[]} */
  const findings = [];
  const seen = new Set();
  /** @type {Array<{f: Finding, key: string}>|null} 点検中のシーンの指摘（前回の結果として残す） */
  let collecting = null;
  const report = (f, key) => {
    if (seen.has(key)) return;
    seen.add(key);
    collecting?.push({ f, key });
    findings.push({ ...f, id: key });
  };
  const push = (f) => findings.push({ ...f, id: f.id ?? `${f.check}|${f.cut}` });

  // シーンの点検は preset によらない（画面は等倍で撮り、時刻は完成版の fps で見る）ので、下書きと完成版で同じ記録を使う
  const cacheDir = path.join(projectDir, 'reviews', '.check-cache');
  const cacheFile = path.join(cacheDir, `${ratioDir(r)}.json`);
  for (const legacy of ['draft', 'final']) removeFile(path.join(cacheDir, `${legacy}-${ratioDir(r)}.json`));
  /** @type {{scenes?: Record<string, {start: number, items: Array<{f: Finding, key: string}>}>, fills?: Record<string, {first?: Fill, second?: Fill, early?: Fill, last?: Fill}>, loop?: {key: string, finding: Finding|null}}} */
  let old = {};
  try { old = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* 初回 */ }
  // 鍵を作れない（シーンの HTML が無いなど）シーンは、毎回開いて点検する（開けないことを指摘する）
  const keys = tl.scenes.map((s, i) => {
    try {
      // シーンの絶対時刻は入れない（後ろへずれただけのシーンは、前回の指摘の時刻をずらして使う）。
      // 完成版のコマの格子とシーンの先頭のずれ（phase）とコマの数は入れる（最後のコマとつなぎ目の直後のコマの、シーン内の時刻が決まる）
      const { f0, frames } = sceneFrames(s, tl.fps);
      return crypto.createHash('sha256')
        .update(JSON.stringify([checker, i, tl.fps, frameTime(s, tl.fps, f0, 0), frames, pageHash(projectDir, s.id, r)])).digest('hex');
    } catch {
      return null;
    }
  });
  const last = tl.scenes.length - 1;
  const loopBuild = tl.loop && stage === 'build';
  const loopKey = loopBuild && keys[0] && keys[last] ? `${keys[0]}|${keys[last]}` : null;
  const loopReused = loopKey !== null && old.loop?.key === loopKey;
  /** @type {Record<string, Array<{f: Finding, key: string}>>} */
  const fresh = {};
  /** @type {Array<{first?: Fill, second?: Fill, early?: Fill, last?: Fill} | undefined>} シーンの並び順の、コマの絵の量（blankFindings） */
  const fills = [];
  /** @type {Record<string, {first?: Fill, second?: Fill, early?: Fill, last?: Fill}>} 前回の結果として残す、コマの絵の量 */
  const freshFills = {};

  // 最後のコマは、下書きの点検でも完成版の fps で見る（下書きと完成版で同じ点検にして、記録を分けずに使うため）
  const fps = tl.fps;
  // ループは、build ではシーンのページで撮った最初と最後のコマで見る（final は MP4 で見る）
  const loopShots = loopBuild && !loopReused ? {} : null;
  const ratioStarted = Date.now();
  let reused = 0;
  for (let i = 0; i < tl.scenes.length; i++) {
    const saved = keys[i] ? old.scenes?.[keys[i]] : undefined;
    const needShot = loopShots && (i === 0 || i === last);
    if (saved && !needShot) {
      const items = saved.items.map(({ f, key }) => ({ f: shiftFinding(f, tl.scenes[i].start - saved.start), key }));
      for (const { f, key } of items) report(f, key);
      fresh[keys[i]] = { start: tl.scenes[i].start, items };
      fills[i] = old.fills?.[keys[i]];
      if (fills[i]) freshFills[keys[i]] = fills[i];
      reused++;
      continue;
    }
    collecting = [];
    fills[i] = {};
    const started = Date.now();
    const stats = { samples: 0, shots: 0 };
    await checkScene(await getBrowser(), { projectDir, tl, ratio: r, fps, seen, loopShots, fills: fills[i], intentsSeen, stats }, i, report);
    const s = tl.scenes[i];
    log(`点検 ${r} カット ${i + 1}/${tl.scenes.length}（${round3(s.end - s.start)} 秒）: 時刻 ${stats.samples}、撮影 ${stats.shots} 枚、${seconds(started)} 秒`);
    // 描画のエラーと決定論の崩れは、読み込みの時間切れなど一度きりのことでも出るので残さず、次も開き直す
    if (keys[i] && !collecting.some(({ f }) => UNCACHED_CHECKS.has(f.check))) {
      fresh[keys[i]] = { start: s.start, items: collecting };
      freshFills[keys[i]] = fills[i];
    }
    collecting = null;
  }
  // つなぎ目のちらつきは、前後のシーンのコマで決まるので、シーンの指摘としては残さず、毎回ここで見る
  for (const f of blankFindings(fills, tl)) push({ ...f, id: `blank|${f.cut}` });
  /** @type {Finding|null} */
  let loopResult = loopReused ? old.loop.finding : null;
  if (loopShots?.first && loopShots.last) {
    loopResult = loopFinding(differingRatio(decodePng(loopShots.first), decodePng(loopShots.last)), tl.scenes.length, loopShots.t ?? totalEnd(tl));
  }
  if (loopResult) push({ ...loopResult, id: 'loop|seam' });
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ scenes: fresh, fills: freshFills, ...(loopKey ? { loop: { key: loopKey, finding: loopResult } } : {}) }) + '\n');
  log(`点検 ${r} シーン: 開いて点検 ${tl.scenes.length - reused}、前回のまま ${reused}、${seconds(ratioStarted)} 秒`);

  if (stage === 'final') {
    const file = videoPath(projectDir, tl, r, p);
    if (!fs.existsSync(file)) {
      report({ check: 'media', cut: 1, t: 0, message: `${at(1, 0)}（動画全体）完成版の動画が見つかりません。先に書き出してください。`, evidence: file }, 'media|missing');
    } else {
      const started = Date.now();
      for (const f of await checkVideo(file, tl, { ratio: r, preset: p })) push(f);
      log(`点検 ${r} 完成版の動画（点滅・尺・音量）: ${seconds(started)} 秒`);
    }
    // ループ版は全品質の書き出しのときだけ作る。本編のあとに作るので、本編より古ければ前の書き出しの残り
    if (tl.loop && p === 'final') {
      const loop = loopVideoPath(projectDir, tl, r);
      const whole = (name, message) => push({ check: 'media', cut: 1, t: 0, message: `${at(1, 0)}（ループ版）${message}`, evidence: loop, id: `media|${name}` });
      if (!fs.existsSync(loop)) {
        whole('loop-missing', 'ループ版の動画が見つかりません。assemble.mjs で全品質の書き出しをやり直してください。');
      } else {
        if (fs.existsSync(file) && fs.statSync(loop).mtimeMs < fs.statSync(file).mtimeMs) {
          whole('loop-stale', 'ループ版の動画が本編より古いままです。assemble.mjs で全品質の書き出しをやり直してください。');
        }
        // 継ぎ目は本編と同じシーンの MP4 なので、本編で loop が出ていれば重ねて出さない
        const seamFound = findings.some((f) => f.check === 'loop');
        for (const f of await checkVideo(loop, tl, { ratio: r, preset: p, loopCopy: true })) {
          if (!(f.check === 'loop' && seamFound)) push(f);
        }
      }
    }
  }
  return findings;
}

/** 指摘を、動画の時刻、カットの順に並べる */
const byTime = (a, b) => a.t - b.t || a.cut - b.cut;

// ---- 止め時と例外（SKILL.md の「止め時」） ----

/** 同じ指摘がこの回数続けて残ったら止める（2回直しても残った） */
const PERSIST_RUNS = 3;
/** 指摘が毎回違っても、この回数続けて不合格なら止める（直すと別の問題が出る、のくり返し） */
const MAX_FAILING_RUNS = 5;
/** check-runs.json に残す回数（古いものから捨てる） */
const KEEP_RUNS = 50;

const runsFile = (projectDir) => path.join(projectDir, 'reviews', 'check-runs.json');
const waiversFile = (projectDir) => path.join(projectDir, 'reviews', 'waivers.json');

/** JSON を読む。無い・読めないときは fallback */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 一時の名前に書いてから名前を変える */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.partial`, JSON.stringify(value, null, 2) + '\n');
  replaceFile(`${file}.partial`, file);
}

/**
 * 同じ不具合を回をまたいで見分ける鍵（比率と、点検の中の鍵 id）。
 * @param {{ratio?: string|null, id: string}} f
 */
export const findingKey = (f) => `${f.ratio ?? ''}|${f.id}`;

/**
 * @typedef {{key: string, ratio: string|null, check: string, cut: number, message: string, why: string, at: string}} Waiver
 *   key は点検の中の鍵と証拠（証拠が変われば、例外でなくなる）
 */

/** 証拠が問題の中身で変わらない点検（文に、回数や時刻・食い違った文字が出る）。例外の鍵に文も入れる */
const MESSAGE_KEYED = new Set(['flash', 'determinism', 'text-mismatch', 'media']);

/** 例外にした指摘の鍵（id と証拠。MESSAGE_KEYED の点検は文も） */
const waiverKey = (f) => `${f.id}|${f.evidence ?? ''}${MESSAGE_KEYED.has(f.check) ? `|${f.message}` : ''}`;

/**
 * 例外が、この指摘に当たるか（同じ比率、同じ鍵、同じ証拠）。build と final で共通。
 * @param {Waiver} w
 * @param {Finding & {id: string, ratio?: string|null}} f
 */
export const waiverMatches = (w, f) => w.key === waiverKey(f) && (w.ratio ?? null) === (f.ratio ?? null);

/**
 * reviews/waivers.json（例外にした指摘）。無ければ空
 * @param {string} projectDir
 * @returns {Waiver[]}
 */
export const readWaivers = (projectDir) => readJson(waiversFile(projectDir), []);

/**
 * 例外に当たる指摘に waived: true と理由（why）を付ける（指摘は消さない）。
 * @template {Finding & {id: string, ratio?: string|null}} F
 * @param {F[]} findings
 * @param {Waiver[]} waivers
 * @returns {Array<F & {waived?: true, why?: string}>}
 */
export function applyWaivers(findings, waivers) {
  return findings.map((f) => {
    const w = waivers.find((x) => waiverMatches(x, f));
    return w ? { ...f, waived: /** @type {true} */ (true), why: w.why } : f;
  });
}

/**
 * 止め時。その段階の、数え直しの時刻より後の回のうち、最後に続いている不合格の回を見る。
 * - 同じ指摘が PERSIST_RUNS 回続けて残った（2回直しても残った）: kind 'persistent'、残った指摘の鍵
 * - 指摘が違っても MAX_FAILING_RUNS 回続けて不合格: kind 'many'、今の指摘の鍵
 * 合格した回で数え直す。毎回違う指摘で3回不合格なのは、直すたびに進んでいるので止めない。
 * @param {Array<{at: string, stage: string, keys: string[]}>} runs
 * @param {string} stage
 * @param {number} resetAt 数え直しの時刻（ミリ秒）
 * @returns {{kind: 'persistent'|'many', keys: string[]} | null}
 */
export function stopRule(runs, stage, resetAt) {
  const mine = runs.filter((r) => r.stage === stage && Date.parse(r.at) > resetAt);
  // 比率ごとに数える（ある比率だけを点検して通った回で、ほかの比率の続きを切らない）。
  // 比率の無い指摘（表示時間など。鍵が「|」で始まる）は、どの比率にも入れる。ratios の無い回は、全部を1つとして数える
  const groups = new Set(mine.flatMap((r) => r.ratios ?? ['']));
  /** @type {{kind: 'persistent'|'many', keys: string[]} | null} */
  let found = null;
  for (const g of groups) {
    const runsOf = g === '' ? mine.filter((r) => !r.ratios)
      : mine.filter((r) => r.ratios?.includes(g)).map((r) => ({ ...r, keys: r.keys.filter((k) => k.startsWith(`${g}|`) || k.startsWith('|')) }));
    const hit = streakRule(runsOf);
    if (!hit) continue;
    if (!found || (hit.kind === 'persistent' && found.kind === 'many')) found = { kind: hit.kind, keys: [] };
    if (hit.kind === found.kind) found.keys = [...new Set([...found.keys, ...hit.keys])];
  }
  return found;
}

/**
 * 1つの比率（または全体）の回の列で、最後に続く不合格の回を見る（stopRule の中身）。
 * @param {Array<{keys: string[]}>} mine
 * @returns {{kind: 'persistent'|'many', keys: string[]} | null}
 */
function streakRule(mine) {
  const streak = [];
  for (let i = mine.length - 1; i >= 0 && mine[i].keys.length > 0; i--) streak.unshift(mine[i]);
  if (streak.length >= PERSIST_RUNS) {
    const tail = streak.slice(-PERSIST_RUNS);
    const keys = tail[tail.length - 1].keys.filter((k) => tail.every((r) => r.keys.includes(k)));
    if (keys.length) return { kind: 'persistent', keys };
  }
  if (streak.length >= MAX_FAILING_RUNS) return { kind: 'many', keys: streak[streak.length - 1].keys };
  return null;
}

/**
 * 数え直しの時刻: 指摘の記録（loggedAt）と関門の承認（approvedAt）のうち最も新しいもの（ミリ秒。無ければ 0）。
 * 利用者に相談して「このまま直し続けて」となったら、その返事を feedback.mjs log で記録すれば数え直しになる。
 * 例外では数え直さない（例外にした指摘は次の回から数えないので要らない。数え直しに使えてしまうため）。
 * @param {string} projectDir
 */
function resetTime(projectDir) {
  const times = [];
  try {
    for (const it of readFeedbackLog(projectDir).items) times.push(it.loggedAt);
  } catch { /* 記録が読めなければ数えない */ }
  const project = readJson(path.join(projectDir, 'project.json'), {});
  for (const g of Object.values(project?.gates ?? {})) times.push(g?.approvedAt);
  // コースを本番に上げて外した承認も、外した時刻（until）までは数え直しの基準に残す（基準が前に戻らない）
  for (const h of project?.gateHistory ?? []) times.push(h?.record?.approvedAt, h?.until);
  return Math.max(0, ...times.map((t) => Date.parse(t)).filter(Number.isFinite));
}

/**
 * 点検の1回を reviews/check-runs.json に記録する。例外にした指摘と意図どおりの指摘は数えない（それだけなら合格の回）。
 * 最後の回の指摘（例外を除く）は番号つきで残し、check.mjs --waive の番号はこれを指す。
 * @param {string} projectDir
 * @param {Stage} stage
 * @param {Array<Finding & {id: string, ratio?: string|null, waived?: boolean}>} findings
 * @param {string[]} [ratios] 点検した比率（比率ごとに数えるため）
 * @param {string} [at]
 */
export function recordRun(projectDir, stage, findings, ratios, at = new Date().toISOString()) {
  const open = findings.filter((f) => !f.waived && !f.intended);
  const data = readJson(runsFile(projectDir), { runs: [] });
  const run = { at, stage, ...(ratios ? { ratios } : {}), keys: [...new Set(open.map(findingKey))] };
  data.runs = [...(data.runs ?? []), run].slice(-KEEP_RUNS);
  data.last = { at, stage, findings: open };
  writeJson(runsFile(projectDir), data);
}

/**
 * 今の止め時の判定（stopRule を、記録と数え直しの時刻で）。
 * @param {string} projectDir
 * @param {Stage} stage
 */
export function stopAdvice(projectDir, stage) {
  return stopRule(readJson(runsFile(projectDir), { runs: [] }).runs ?? [], stage, resetTime(projectDir));
}

/**
 * 最後に出した点検の結果の番号（1 始まり）の指摘を、理由をつけて例外にする（reviews/waivers.json に足す）。
 * 例外にするのは、フレームの画像を見て、問題ではないと確かめたときだけ（SKILL.md の「止め時」）。
 * @param {string} projectDir
 * @param {number[]} numbers
 * @param {string} why
 * @returns {Waiver[]} 足した例外
 */
export function waive(projectDir, numbers, why) {
  if (!why?.trim()) throw new Error('--why で理由を書いてください（フレームの画像を見て、問題ではないと確かめた理由）。');
  const last = readJson(runsFile(projectDir), {}).last;
  if (!last?.findings?.length) throw new Error('例外にできる指摘がありません。先に check.mjs で点検してください。');
  const at = new Date().toISOString();
  const added = numbers.map((n) => {
    const f = last.findings[n - 1];
    if (!f) throw new Error(`番号 ${n} の指摘はありません（最後の点検の指摘は 1〜${last.findings.length}）。`);
    return { key: waiverKey(f), ratio: f.ratio ?? null, check: f.check, cut: f.cut, message: f.message, why: why.trim(), at };
  });
  writeJson(waiversFile(projectDir), [...readWaivers(projectDir), ...added]);
  return added;
}

/**
 * 点検の結果を利用者向けに出し、終了コード（0: 問題なし、1: 問題あり、2: 止め時）を返す。assemble.mjs も使う。
 * 指摘には番号を付ける（--waive の番号）。例外にした指摘は数に入れず、最後に理由と並べる。
 * @param {{ok: boolean, findings: Array<Finding & {ratio?: string|null, waived?: boolean, why?: string, id: string}>, stop?: {kind: string, keys: string[]}}} r
 * @param {string} projectDir
 * @param {(line: string) => void} [log]
 */
export function printChecks(r, projectDir, log = console.log) {
  const label = (f) => `${f.ratio ? `${f.ratio}: ` : ''}${f.message}`;
  const open = r.findings.filter((f) => !f.waived && !f.intended);
  const waived = r.findings.filter((f) => f.waived);
  const intended = r.findings.filter((f) => f.intended && !f.waived);
  if (open.length === 0) log('自動点検: 問題は見つかりませんでした。');
  else {
    log(`自動点検: ${open.length} 件の問題が見つかりました。`);
    open.forEach((f, i) => log(`${i + 1}. ${label(f)}`));
  }
  if (waived.length) {
    log(`例外にした指摘（${waived.length} 件。数えていません）:`);
    for (const f of waived) log(`- ${label(f)}（理由: ${f.why}）`);
  }
  if (intended.length) {
    const counts = new Map();
    for (const f of intended) counts.set(f.check, (counts.get(f.check) ?? 0) + 1);
    log(`意図どおり（既定から外した演出。数えていません）: ${intended.length} 件（${[...counts].map(([c, n]) => `${c} ${n}件`).join('、')}）`);
  }
  if (!r.stop) return r.ok ? 0 : 1;
  const numbered = (k) => {
    const i = open.findIndex((f) => findingKey(f) === k);
    return i >= 0 ? `${i + 1}. ${label(open[i])}` : k;
  };
  log('');
  log('ここで止めて利用者に相談してください（SKILL.md の「止め時」）。');
  log(r.stop.kind === 'persistent'
    ? `次の指摘は、${PERSIST_RUNS}回続けて残った（2回直しても直らなかった）ものです:`
    : `直すたびに別の問題が出て、${MAX_FAILING_RUNS}回続けて点検を通っていません。今の指摘:`);
  for (const k of r.stop.keys) log(`  ${numbered(k)}`);
  log('利用者に、次の3つから選んでもらってください。');
  log(`  1. 問題ではないので例外にする: フレームの画像を見て確かめたうえで、node "${fileURLToPath(import.meta.url)}" "${projectDir}" --waive <番号> --why "理由"（納品のページに理由と並んで出ます）`);
  log('  2. 直さずに残す: reviews/compromises.md に書き、同じく --waive で例外にする');
  log('  3. 作り方を変える: そのカットの構成や見せ方を変える案を出す');
  log('「このまま直し続けて」と言われたら、その返事を feedback.mjs log で記録してから続けてください（数え直しになります）。');
  return 2;
}

/**
 * 自動点検を通す。build はシーンの点検、final はそれに加えて完成版の MP4 の点検。
 * 比率を指定しなければ timeline.json のすべての比率を点検する（比率ごとにレイアウトを組み直しているため）。
 * 結果は比率ごとに reviews/checks-<stage>-<比率の : を x に>.json にも保存する（関門のページが読む）。
 * timeline.json だけで分かる点検（表示時間、ナレーションの重なり）は比率によらないので、返す指摘には1回だけ入れる（ratio なし）。
 * 前回から変わっていないシーンは開き直さない（checkRatio）ので、毎回動画全体を点検してよい。
 * 例外にした指摘（reviews/waivers.json）は waived: true を付けて残し、ok に数えない。
 * 意図した演出の宣言（settings.intent と data-ms-intent。applyIntents）に当たる指摘も intended: true を付けて残し、ok に数えない。
 * 実行のたびに reviews/check-runs.json へ記録し、止め時（stopRule）に当たれば stop を返す。
 * @param {string} projectDir
 * @param {{ratio?: string, preset?: 'draft'|'final', stage?: Stage, browser?: any, checker?: string, log?: (line: string) => void}} [opts]
 *   preset の既定は、final なら final、build なら draft。checker は点検の版（試験で変えるため。既定はこのファイルの sha256）。
 *   log は途中の様子を書く先（beginRun の log。シーンごとの時刻の数・撮影の数・秒数）
 * @returns {Promise<{ok: boolean, findings: Array<Finding & {ratio?: string}>}>}
 */
export async function runChecks(projectDir, { ratio, preset, stage = 'build', browser, checker = checkerVersion(), log = () => {} } = {}) {
  if (stage !== 'build' && stage !== 'final') throw new Error(`段階 ${stage} は使えません（build か final）`);
  const tl = readTimeline(projectDir);
  const v = validateTimeline(tl);
  if (!v.ok) throw new Error(`timeline.json に誤りがあるため点検できません:\n${v.errors.join('\n')}`);
  const ratios = ratio ? [ratio] : tl.ratios;
  const p = preset ?? (stage === 'final' ? 'final' : 'draft');
  for (const r of ratios) checkArgs(r, p);
  log(`点検（${stage}）: 比率 ${ratios.join('・')}、カット ${tl.scenes.length}（${round3(totalEnd(tl))} 秒）`);

  const waivers = readWaivers(projectDir);
  const intents = projectIntents(projectDir, tl);
  /** 例外と意図どおりの印を付ける */
  const mark = (fs) => applyIntents(applyWaivers(fs, waivers), intents, tl);
  const pass = (f) => f.waived || f.intended;
  /** @type {Array<{scene: string, checks: string[]}>} */
  const intentsSeen = [];
  const timeline = mark(timelineFindings(tl).map((f) => ({ ...f, id: `${f.check}|${f.evidence}` })));
  const findings = [...timeline];
  // ブラウザは、開き直すシーンがあるときだけ起動する
  /** @type {any} */
  let launched = null;
  const getBrowser = async () => browser ?? (launched ??= await loadPuppeteer().launch({ headless: 'shell', args: LAUNCH_ARGS }));
  try {
    for (const r of ratios) {
      const own = mark((await checkRatio(getBrowser, { projectDir, tl, ratio: r, preset: p, stage, checker, intentsSeen, log })).map((f) => ({ ...f, ratio: r })));
      const all = [...timeline, ...own].sort(byTime);
      const out = path.join(projectDir, 'reviews', `checks-${stage}-${ratioDir(r)}.json`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ stage, ratio: r, preset: p, ok: all.every(pass), findings: all }, null, 2) + '\n');
      findings.push(...own);
    }
  } finally {
    await launched?.close();
  }
  findings.sort(byTime);
  recordIntentSeen(projectDir, intentsSeen, tl);
  recordRun(projectDir, stage, findings, ratios);
  const stop = stopAdvice(projectDir, stage);
  return { ok: findings.every(pass), findings, ...(stop ? { stop } : {}) };
}

// ---- 意図した演出の宣言 ----

/**
 * シーンの要素の data-ms-intent に書ける点検（要素の指摘になるものと、body に書くつなぎ目の blank）。
 * flash・hold・narration・loudness・loop は MP4 や timeline.json から見る点検で、要素とは結びつかないので、project.mjs intent で宣言する
 */
const ELEMENT_INTENT_CHECKS = ['overflow', 'safe-area', 'overlap', 'cover', 'contrast', 'blank'];

/** 動画全体にかかわり、シーンで絞れない点検（scenes の無い宣言だけが当たる） */
const WHOLE_CHECKS = new Set(['loudness', 'loop']);

/**
 * project.json の settings.intent。無い・読めないときは空。宣言できない名前があれば、点検の前に止める
 * @param {string} projectDir
 * @returns {import('./project.mjs').Intent[]}
 */
function projectIntents(projectDir, tl) {
  let intents = [];
  try {
    intents = readProject(projectDir).settings.intent ?? [];
  } catch {
    return [];
  }
  // 打ち間違えたシーンの id は、宣言が効かないまま気づけないので知らせる
  assertIntentScenes(projectDir, tl);
  const bad = intents.filter((x) => !INTENT_CHECKS.includes(x.check));
  if (bad.length) {
    throw new Error(`project.json の settings.intent の ${bad.map((x) => x.check).join('、')} は宣言できません（正しく作るための点検か、知らない名前です）。`
      + `その項目を外し、node "${fileURLToPath(new URL('./project.mjs', import.meta.url))}" intent "${projectDir}" --check <名前> --why "理由" で宣言し直してください。`);
  }
  return intents;
}

/**
 * 意図した演出の宣言に当たる指摘に intended: true と理由（intendedWhy）を付ける（指摘は消さない）。
 * 当たるのは、指摘に関わる要素の data-ms-intent（f.intent）にその点検があるときか、settings.intent に同じ点検があり、
 * scenes が無いか、指摘のカットのシーンが scenes に入っているとき。音量とループの継ぎ目は、scenes の無い宣言だけが当たる。
 * INTENT_CHECKS に無い点検（原稿との食い違い・直書き・決定論・MP4・描画のエラー）には効かない。
 * @template {Finding} F
 * @param {F[]} findings
 * @param {Array<{check: string, why: string, scenes?: string[]}>} intents
 * @param {{scenes: Array<{id: string}>}} tl
 * @returns {Array<F & {intended?: true, intendedWhy?: string}>}
 */
export function applyIntents(findings, intents, tl) {
  return findings.map((f) => {
    if (!INTENT_CHECKS.includes(f.check)) return f;
    if (f.intent?.includes(f.check)) return { ...f, intended: /** @type {true} */ (true), intendedWhy: 'シーンの要素で宣言（data-ms-intent）' };
    const sceneId = WHOLE_CHECKS.has(f.check) || !(f.cut > 0) ? undefined : tl.scenes[f.cut - 1]?.id;
    const d = intents.find((x) => x.check === f.check && (!x.scenes?.length || (sceneId !== undefined && x.scenes.includes(sceneId))));
    return d ? { ...f, intended: /** @type {true} */ (true), intendedWhy: d.why } : f;
  });
}

const intentSeenFile = (projectDir) => path.join(projectDir, 'reviews', 'intent-seen.json');

/**
 * シーンの data-ms-intent の宣言を初めて見た日時（確認ページの「後から足した」に使う）。無ければ空
 * @param {string} projectDir
 * @returns {Array<{scene: string, check: string, firstSeenAt: string}>}
 */
export const readIntentSeen = (projectDir) => readJson(intentSeenFile(projectDir), []);

/**
 * シーンの宣言の記録を、今の宣言に合わせる。
 * 今回開いたシーンは、今回見た宣言だけを残す（外した宣言は消え、新しい宣言は今の日時で足し、前からある宣言は初めて見た日時を引き継ぐ）。
 * 開き直さなかったシーン（前回から変わっていない）は前の記録のまま。timeline.json に無いシーンの記録は消す。
 * @param {string} projectDir
 * @param {Array<{scene: string, checks: string[], counts?: Record<string, number>}>} seen 今回開いたシーンと、その宣言と宣言した要素の数（比率ごとに同じシーンが並ぶことがある）
 * @param {{scenes: Array<{id: string}>}} tl
 */
function recordIntentSeen(projectDir, seen, tl) {
  const before = readIntentSeen(projectDir);
  const at = new Date().toISOString();
  const ids = new Set(tl.scenes.map((s) => s.id));
  /** @type {Map<string, Set<string>>} 今回開いたシーンごとの宣言 */
  const now = new Map();
  /** @type {Map<string, number>} シーンと点検ごとの、宣言した要素の数（比率のうち多いほう） */
  const counts = new Map();
  for (const { scene, checks, counts: c = {} } of seen) {
    const set = now.get(scene) ?? new Set();
    for (const check of checks) {
      set.add(check);
      counts.set(`${scene}|${check}`, Math.max(counts.get(`${scene}|${check}`) ?? 0, c[check] ?? 0));
    }
    now.set(scene, set);
  }
  const kept = before.filter((x) => ids.has(x.scene) && (!now.has(x.scene) || now.get(x.scene).has(x.check)));
  const added = [...now].flatMap(([scene, checks]) => [...checks]
    .filter((check) => !kept.some((x) => x.scene === scene && x.check === check))
    .map((check) => ({ scene, check, firstSeenAt: at })));
  const withCount = (x) => (counts.has(`${x.scene}|${x.check}`) ? { ...x, count: counts.get(`${x.scene}|${x.check}`) } : x);
  const list = [...kept, ...added].map(withCount);
  if (JSON.stringify(list) !== JSON.stringify(before)) writeJson(intentSeenFile(projectDir), list);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const projectDir = args[0];
  if (!projectDir || projectDir.startsWith('--')) {
    console.error('使い方: node check.mjs <制作フォルダ> [--ratio 16:9] [--stage build|final] [--preset draft|final] [--json]（--ratio を省くと、すべての比率を点検する）'
      + ' / node check.mjs <制作フォルダ> --waive <番号>[,<番号>…] --why "理由"（最後の点検の指摘を例外にする）');
    process.exit(1);
  }
  try {
    // 例外の記録も、点検と同じ鍵の下で書く（実行中の点検と記録が混ざらないように）
    const run = beginRun(projectDir, args.includes('--waive') ? 'check.mjs --waive' : 'check.mjs');
    if (args.includes('--waive')) {
      const numbers = String(opt('--waive') ?? '').split(',').map((x) => x.trim());
      if (!numbers.every((x) => /^\d+$/.test(x))) throw new Error('--waive のあとに、最後の点検の指摘の番号を書いてください（例: --waive 2 または --waive 1,3）。');
      for (const w of waive(projectDir, numbers.map(Number), opt('--why') ?? '')) {
        console.log(`例外にしました: ${w.ratio ? `${w.ratio}: ` : ''}${w.message}（理由: ${w.why}）`);
      }
      console.log('例外は、確認ページの「残った妥協点」に理由と並んで出ます。中身（証拠）が変わると、例外ではなくなります。');
      process.exit(0);
    }
    const r = await runChecks(projectDir, {
      ratio: opt('--ratio'),
      stage: /** @type {Stage} */ (opt('--stage') ?? 'build'),
      preset: /** @type {any} */ (opt('--preset')),
      log: run.log,
    });
    if (args.includes('--json')) {
      console.log(JSON.stringify(r, null, 2));
      process.exitCode = r.stop ? 2 : r.ok ? 0 : 1;
    } else {
      process.exitCode = printChecks(r, projectDir);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    // 点検そのものが動かなかった（時刻表の誤り、ほかの実行中など）は 4 にし、問題ありの 1 と分ける。例外の記録（--waive）の誤りは 1
    // ほかの実行中で断られたときは、--waive でも 4（記録できなかった）
    const msg = e instanceof Error ? e.message : String(e);
    process.exit(args.includes('--waive') && !/が実行中です/.test(msg) ? 1 : 4);
  }
}
