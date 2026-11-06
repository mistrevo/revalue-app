// 音のミックス。ナレーション・効果音・BGM を 1 本にまとめ、音量をそろえて audio/master.wav（48kHz ステレオ）に書く。
// BGM はナレーションが鳴っている間だけ下げる（sidechaincompress）。音量は測った値から直線で -14 LUFS にそろえ、
// 頂点が超えるときだけなめらかに抑える。書き出しと同じ AAC にして測り、-1 dBTP 以下・-14 LUFS ±0.5 に収まるまで合わせ直す。
// ただし効果音だけ（ナレーションも BGM も無い）のときは、-14 LUFS まで持ち上げると効果音が耳に刺さるので音量はそろえず、
// 効果音どうしの釣り合いのまま、いちばん大きい頂点を -3 dBFS にそろえる（統合の音量は -16 LUFS を超えない）。
// 音の入力が前回と同じなら混ぜ直さない（audio/master.json の鍵。絵だけを直したときに、音量の測り直しを繰り返さないため）。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beginRun } from './lock.mjs';
import { isMain, removeFile, replaceFile } from './paths.mjs';
import { toolsId } from './render.mjs';
import { BGM_REPEAT_XFADE, bgmOffsetError, bgmRepeatError, hasVoiceOrMusic, readTimeline } from './timeline.mjs';
import { renderSfxTrack } from './sfx.mjs';
import { ffmpegVersion, ffprobePath, filterScriptArgs, measureLoudness, runFfmpeg as ffmpeg } from './tools.mjs';

// 音量と頂点の目標。自動点検（check.mjs）の基準は -14 LUFS ±1、トゥルーピーク -1 dBTP 以下。
// 頂点の余裕は 3 段ある。
// - TARGET_TP（-1.5）: master.wav の頂点の最初の目標。AAC にすると頂点が少し上がる分を見込んで、-1 より 0.5 dB 下げる。
// - PRE_LIMIT_MARGIN（0.5）: 頂点を抑える処理（alimiter）の上限を、さらに下げる量。抑える処理は標本の値で抑えるので、
//   標本の間の頂点（トゥルーピーク）が上限を少し超える分を見込む。
// - MAX_ENCODED_TP（-1.05）と TP_MARGIN（0.3）: 実際に AAC にして測った頂点の合格線と、超えたときに次の目標を合格線より下げる量。
//   書き出しも同じ WAV を同じ AAC にするので結果は同じになる。-1.05 は表示の丸めの差のぶんだけ -1 より空ける。
// 音量と頂点は、点検と同じ tools.mjs の measureLoudness（ebur128）で測る。
export const TARGET_LUFS = -14;
export const TARGET_TP = -1.5;
/** 書き出しの音の形式（assemble.mjs も同じものを使う） */
export const AAC_ARGS = ['-c:a', 'aac', '-b:a', '192k'];
const MAX_ENCODED_TP = -1.05;
const TP_MARGIN = 0.3;
const PRE_LIMIT_MARGIN = 0.5;
/** AAC にして測った音量の合格線（目標からの差、LUFS）。点検の ±1 より内側にする */
const MAX_LUFS_DIFF = 0.5;
/** 音量の合わせ直しを試す回数の上限 */
const MAX_TRIES = 4;
/** 頂点を抑えた後、音量を測って持ち上げ直す回数の上限と、そこで止める差（LUFS） */
const FIT_TRIES = 4;
const FIT_STEP = 0.1;
/** BGM を終わりに向けて絞る秒数 */
const BGM_FADE_OUT = 1.5;
/** ナレーションの下で BGM をどれだけ下げるか（dB）。圧縮のかかり方から逆算する目安 */
const DUCK_DB = 8;
/** ナレーションのおおよその音量（dBFS）。ここで DUCK_DB 下がるようにしきい値を決める */
const NARRATION_LEVEL_DB = -20;
const SAMPLE_RATE = 48000;
/**
 * 効果音だけ（ナレーションも BGM も無い）の動画: いちばん大きい頂点（サンプルの最大値、dBFS）をここにそろえる。
 * 統合の音量はそろえないが、SFX_MAX_LUFS を超えない（点検の基準は -14 LUFS 以下。AAC にしたときの揺れの分だけ下げる）
 */
export const SFX_PEAK = -3;
export const SFX_MAX_LUFS = -16;

/** 動画の総尺（秒） */
export const totalSeconds = (tl) => tl.scenes[tl.scenes.length - 1].end;

const SOURCES = ['./mix.mjs', './sfx.mjs', './timeline.mjs', './wav.mjs'].map((f) => new URL(f, import.meta.url));

/**
 * master.wav を決める入力すべてから作る sha256。ナレーション（ファイル・開始）、効果音、fps と seed、BGM の設定、総尺、
 * 参照するファイルの中身、混ぜ方のプログラム（mix.mjs、sfx.mjs、BGM のつなぎ目の長さを持つ timeline.mjs、sfx が書く wav.mjs）、道具（ffmpeg）の版。
 * @param {string} projectDir
 * @param {import('./timeline.mjs').Timeline} tl
 * @param {Array<{audio: string, start: number}>} narr 音声ファイルのあるナレーションの行
 */
function mixHash(projectDir, tl, narr) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({
    narration: narr.map((n) => ({ audio: n.audio, start: n.start })), sfx: tl.sfx ?? [], bgm: tl.bgm ?? null, total: totalSeconds(tl), tools: toolsId(),
    // 効果音は fps で置く位置（1フレーム後）が、seed で波形が決まる
    fps: tl.fps, seed: tl.seed ?? 1,
  }));
  const files = [...narr.map((n) => n.audio), ...(tl.bgm?.file ? [tl.bgm.file] : [])];
  for (const f of files) hash.update(`\0${f}\0`).update(fs.readFileSync(path.resolve(projectDir, f)));
  for (const src of SOURCES) hash.update('\0src\0').update(fs.readFileSync(src));
  return hash.digest('hex');
}

/**
 * ナレーション・効果音・BGM を混ぜて audio/master.wav に書く。音の元が何も無ければ null。
 * ナレーションは narration[].start（動画の先頭からの絶対秒）に置く。
 * @param {string} projectDir
 * @returns {Promise<string|null>} master.wav のパス
 */
export async function mixAudio(projectDir, { encodedMeter = encodedLoudness } = {}) {
  const tl = readTimeline(projectDir);
  const total = totalSeconds(tl);
  const audioDir = path.join(projectDir, 'audio');
  const abs = (f) => path.resolve(projectDir, f);

  const narr = (tl.narration ?? []).filter((n) => n.audio);
  for (const n of narr) {
    if (!fs.existsSync(abs(n.audio))) throw new Error(`ナレーション ${n.id} の音声ファイルがありません: ${abs(n.audio)}`);
  }
  const hasSfx = (tl.sfx ?? []).length > 0;
  const bgm = tl.bgm?.file ? abs(tl.bgm.file) : null;
  if (bgm && !fs.existsSync(bgm)) throw new Error(`BGM のファイルがありません: ${bgm}`);
  if (!narr.length && !hasSfx && !bgm) {
    // 前の書き出しの master が残っていると、音なしの動画に古い音が付いてしまう
    removeFile(path.join(audioDir, 'master.wav'));
    removeFile(path.join(audioDir, 'master.json'));
    return null;
  }

  fs.mkdirSync(audioDir, { recursive: true });
  const key = mixHash(projectDir, tl, narr);
  const metaFile = path.join(audioDir, 'master.json');
  const done = () => fs.writeFileSync(metaFile, JSON.stringify({ hash: key }, null, 2) + '\n');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(metaFile, 'utf8')).hash; } catch { /* 初回 */ }
  if (previous === key && fs.existsSync(path.join(audioDir, 'master.wav'))) return path.join(audioDir, 'master.wav');
  // 混ぜ直す間に止まっても、古い鍵で古い master を使わないよう、先に消す
  removeFile(metaFile);
  const inputs = [];
  const chains = [];
  const norm = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const labels = [];

  const narLabels = [];
  for (const n of narr) {
    const i = inputs.length;
    inputs.push(abs(n.audio));
    const ms = Math.round(n.start * 1000);
    chains.push(`[${i}:a]${norm},adelay=${ms}|${ms}[n${i}]`);
    narLabels.push(`[n${i}]`);
  }
  if (narLabels.length) {
    chains.push(`${narLabels.join('')}amix=inputs=${narLabels.length}:normalize=0:duration=longest,apad=whole_dur=${total},atrim=0:${total}[nar]`);
  }

  if (hasSfx) {
    const sfxFile = path.join(audioDir, 'sfx.wav');
    renderSfxTrack(tl, sfxFile);
    const i = inputs.length;
    inputs.push(sfxFile);
    chains.push(`[${i}:a]${norm}[sfx]`);
    labels.push('[sfx]');
  }

  if (bgm) {
    const i = inputs.length;
    inputs.push(bgm);
    const gain = tl.bgm.gain ?? 0;
    // offset（秒）があれば、曲のその位置から使う（生成した曲は頼んだ長さより長いことが多く、山の位置を映像に合わせるため）
    const offsetError = bgmOffsetError(tl.bgm) ?? bgmRepeatError(tl.bgm);
    if (offsetError) throw new Error(offsetError);
    const offset = tl.bgm.offset ?? 0;
    const repeat = tl.bgm.repeat ?? null;
    let song = audioSeconds(bgm);
    let src = `[${i}:a]`;
    const span = repeat ? repeat.to - repeat.from : 0;
    const times = repeat?.times ?? 1;
    if (repeat) {
      if (repeat.to >= song) throw new Error(`bgm.repeat の to（${repeat.to} 秒）が曲の長さ（${song.toFixed(1)} 秒）以上です。曲の終わりより前の時刻にしてください。`);
      // to まで鳴らし、from へ戻って続ける（times 回）。つなぎ目は短く重ねて（等しい力の重ね方）、音のはじけを出さない。
      // 重ねるのは to の手前と from の手前で、重ね終えた所がちょうど from の拍の頭になる（to の頭の音は鳴らさず、拍の頭の音を2つ重ねない）
      const d = BGM_REPEAT_XFADE;
      // 区間ごとに曲を入力し直す（1つの入力を asplit で分けると、終わりを切った区間の後ろの重ねが抜けて曲が短くなる。ffmpeg 6.1 で確かめた）
      const part = (k) => {
        if (k === 0) return i;
        inputs.push(bgm);
        return inputs.length - 1;
      };
      chains.push(`[${part(0)}:a]${norm},atrim=0:${repeat.to},asetpts=PTS-STARTPTS[rs0]`);
      for (let k = 1; k < times; k++) chains.push(`[${part(k)}:a]${norm},atrim=start=${repeat.from - d}:end=${repeat.to},asetpts=PTS-STARTPTS[rs${k}]`);
      chains.push(`[${part(times)}:a]${norm},atrim=start=${repeat.from - d},asetpts=PTS-STARTPTS[rs${times}]`);
      let prev = '[rs0]';
      for (let k = 1; k <= times; k++) {
        const out = k === times ? '[rep]' : `[rc${k}]`;
        chains.push(`${prev}[rs${k}]acrossfade=d=${d}:c1=qsin:c2=qsin${out}`);
        prev = out;
      }
      src = '[rep]';
      song += span * times;
    }
    // 曲の長さ以上だと無音になるので止める
    if (offset > 0 && offset >= song) throw new Error(`bgm.offset（${offset} 秒）が曲の長さ（${song.toFixed(1)} 秒）以上で、BGM が鳴りません。曲の長さより短くしてください。`);
    if (song - offset < total - BGM_FADE_OUT) {
      const short = total - (song - offset);
      // くり返しがあれば、動画の終わりまで届く回数を出す
      const advice = repeat
        ? `bgm.repeat の times を ${times + Math.ceil(short / span)} にする（${span.toFixed(1)} 秒の区間を、あと ${Math.ceil(short / span)} 回くり返す）か、曲を作り直してください（audio.md）。`
        : '曲を作り直すか、bgm.repeat で曲の途中の区間をくり返して伸ばしてください（足りない秒数を区間の長さで割って切り上げた回数を times に。audio.md）。';
      console.warn(`注意: BGM は動画の ${(song - offset).toFixed(1)} 秒で終わり、終わりまでの ${short.toFixed(1)} 秒は BGM が鳴りません。` + advice);
    }
    const skip = offset > 0 ? `atrim=start=${offset},asetpts=PTS-STARTPTS,` : '';
    // 動画の長さに合わせて切り、短ければ無音で埋める。終わりの 1.5 秒で絞る
    const fadeAt = Math.max(0, total - BGM_FADE_OUT);
    chains.push(`${src}${skip}${norm},volume=${gain}dB,apad=whole_dur=${total},atrim=0:${total},afade=t=out:st=${fadeAt}:d=${Math.min(BGM_FADE_OUT, total)}[bgm]`);
    if (narLabels.length) {
      // 比 R の圧縮は、しきい値を超えた分を (1 - 1/R) だけ下げる。ナレーションの目安の音量で DUCK_DB 下がるよう決める
      const ratio = 4;
      const thresholdDb = NARRATION_LEVEL_DB - DUCK_DB / (1 - 1 / ratio);
      chains.push('[nar]asplit=2[nar1][nar2]');
      chains.push(`[bgm][nar2]sidechaincompress=threshold=${(10 ** (thresholdDb / 20)).toFixed(5)}:ratio=${ratio}:attack=30:release=400:makeup=1[duck]`);
      labels.push('[nar1]', '[duck]');
    } else {
      labels.push('[bgm]');
    }
  } else if (narLabels.length) {
    labels.push('[nar]');
  }

  const premix = path.join(audioDir, '.premix.wav');
  const master = path.join(audioDir, 'master.wav');
  const partial = path.join(audioDir, '.master.partial.wav');
  const script = path.join(audioDir, '.mix-filter.txt');
  const inArgs = inputs.flatMap((f) => ['-i', f]);
  const mixChain = `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,apad=whole_dur=${total},atrim=0:${total},aresample=${SAMPLE_RATE}`;
  try {
    // ナレーションが多いとコマンドが Windows の長さの上限を超えるので、フィルターはファイルで渡す
    fs.writeFileSync(script, [...chains, `${mixChain}[out]`].join(';\n'));
    ffmpeg([...inArgs, ...filterScriptArgs(script, ffmpegVersion()), '-map', '[out]', '-ac', '2', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_f32le', premix]);

    if (!hasVoiceOrMusic(tl)) {
      // 全体が無音だと何も鳴らない動画になるので、通常の経路と同じく止める
      const vd = ffmpeg(['-i', premix, '-af', 'volumedetect', '-f', 'null', '-']);
      const peak = Number(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(vd)?.[1]);
      if (!Number.isFinite(peak) || peak < -80) throw new Error('音がほとんど無音のため、効果音を鳴らせません。効果音の gain とファイルを確かめてください。');
      // 効果音だけ: 効果音どうしの釣り合いは timeline の gain のまま、全体を同じだけ上げ下げして、いちばん大きい頂点を SFX_PEAK にする
      // （目安の gain のままでは頂点が -10 dBFS 前後で、効果音の多い動画が弱く聞こえる）。ただし統合の音量は SFX_MAX_LUFS を超えない
      // （詰めて鳴らすと、頂点をそろえただけで -14 LUFS を超えるため）。頂点（サンプルの最大値）は念のため TARGET_TP より少し下に抑える
      const m = measureLoudness(premix);
      let lift = Math.min(SFX_PEAK - peak, Number.isFinite(m.i) ? SFX_MAX_LUFS - m.i : Infinity);
      const limit = (10 ** ((TARGET_TP - 1) / 20)).toFixed(5);
      // 書き出しと同じ AAC にして頂点を測り、上限を超えたら超えた分だけ全体を下げて混ぜ直す
      // （角ばった音は、AAC にすると頂点が数 dB 上がることがある）
      for (let i = 0; ; i++) {
        ffmpeg(['-i', premix, '-af', `volume=${lift.toFixed(2)}dB,alimiter=limit=${limit}:level=disabled:attack=1:release=50,aresample=${SAMPLE_RATE}`,
          '-ac', '2', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', partial]);
        const got = encodedMeter(partial);
        if (!(got.tp > MAX_ENCODED_TP)) break;
        if (i >= MAX_TRIES - 1) {
          throw new Error(`効果音の頂点を抑えられません。書き出しの形式にすると頂点が ${got.tp.toFixed(1)} dBTP になりました（-1 dBTP 以下にします）。`
            + '角ばった音（持ち込みの効果音など）を、なめらかな音に替えてください。');
        }
        lift -= got.tp - (MAX_ENCODED_TP - TP_MARGIN);
      }
      replaceFile(partial, master);
      done();
      return master;
    }
    const m = measureLoudness(premix);
    if (!Number.isFinite(m.i)) throw new Error('音がほとんど無音のため、音量をそろえられません。ナレーション・効果音・BGM のファイルを確かめてください。');
    // 頂点の目標 tp で -14 LUFS にそろえ、書き出しと同じ AAC にして測る。頂点が上限を超えたら、超えた分だけ tp を下げてやり直す
    // （低音の強い BGM では、AAC にすると位相がずれて頂点が 1〜3 dB 上がることがある）
    let tp = TARGET_TP;
    for (let i = 0; ; i++) {
      fitLoudness(premix, partial, m, tp);
      const got = encodedMeter(partial);
      if (got.tp <= MAX_ENCODED_TP && Math.abs(got.i - TARGET_LUFS) <= MAX_LUFS_DIFF) break;
      // 音量が外れたときは頂点の目標を下げても直らないので、やり直さずに止める
      if (i >= MAX_TRIES - 1 || got.tp <= MAX_ENCODED_TP) {
        throw new Error(`音量をそろえられません。書き出しの形式にすると ${got.i.toFixed(1)} LUFS、頂点 ${got.tp.toFixed(1)} dBTP になりました`
          + `（目標は ${TARGET_LUFS} LUFS ±1、頂点 -1 dBTP 以下）。BGM の音量（bgm.gain）を下げるか、急に大きくなる音（強い打楽器など）が少ない曲に替えてください。`);
      }
      tp = Math.round((tp - (got.tp - (MAX_ENCODED_TP - TP_MARGIN))) * 100) / 100;
    }
    replaceFile(partial, master);
    done();
  } finally {
    removeFile(premix);
    removeFile(script);
    removeFile(partial);
  }
  return master;
}

/**
 * src を -14 LUFS にそろえて out（16 ビットの WAV）に書く。頂点は tp（dBTP）以下にする。
 * 音量は直線の音量変更だけで合わせる（loudnorm の補正は、頂点が目標を超えると黙って動的な補正に切り替わり、
 * 頂点を急に削るので AAC にすると頂点が 2〜3 dB 跳ね上がり、音量も 2 dB 以上外れることがある）。
 * 直線で持ち上げると頂点が tp を超えるときだけ、先に持ち上げてから頂点をなめらかに抑える。
 * 抑えると音量が少し下がるので、測り直して持ち上げる量を足し、抑え直す。
 * @param {string} src
 * @param {string} out
 * @param {{i: number, tp: number}} m src を測った値
 * @param {number} tp 頂点の目標（dBTP）
 */
function fitLoudness(src, out, m, tp) {
  let gain = TARGET_LUFS - m.i;
  const limited = m.tp + gain > tp;
  // alimiter が受け付ける範囲は 0.0625〜1（-24〜0 dBFS）。持ち上げた後に抑えるので、元の音の大きさによらずこの範囲に入る
  const limit = Math.min(1, Math.max(0.0625, 10 ** ((tp - PRE_LIMIT_MARGIN) / 20))).toFixed(6);
  for (let k = 0; ; k++) {
    // 4 倍に上げた標本で抑えるので、標本の間の頂点も抑えられる
    const lim = limited ? `,aresample=${SAMPLE_RATE * 4},alimiter=limit=${limit}:level=disabled:attack=5:release=100` : '';
    ffmpeg(['-i', src, '-af', `volume=${gain.toFixed(3)}dB${lim},aresample=${SAMPLE_RATE}`, '-ac', '2', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', out]);
    if (!limited || k >= FIT_TRIES - 1) return;
    const rest = TARGET_LUFS - measureLoudness(out).i;
    if (!(Math.abs(rest) > FIT_STEP)) return;
    gain += rest;
  }
}

/**
 * 音声ファイルの長さ（秒）。測れなければ Infinity（長さの確かめを飛ばす）
 * @param {string} file
 */
function audioSeconds(file) {
  const r = spawnSync(ffprobePath(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', windowsHide: true });
  const s = Number(String(r.stdout).trim());
  return r.status === 0 && Number.isFinite(s) ? s : Infinity;
}

/**
 * 書き出しと同じ AAC にしたときの統合ラウドネス（LUFS）とトゥルーピーク（dBTP）
 * @param {string} wav
 * @returns {{i: number, tp: number}}
 */
export function encodedLoudness(wav) {
  const tmp = `${wav}.peak.m4a`;
  try {
    ffmpeg(['-i', wav, ...AAC_ARGS, '-f', 'mp4', tmp]);
    return measureLoudness(tmp);
  } finally {
    removeFile(tmp);
  }
}

if (isMain(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('使い方: node mix.mjs <制作フォルダ>');
    process.exit(1);
  }
  try {
    beginRun(dir, 'mix.mjs');
    const f = await mixAudio(dir);
    console.log(f ? `音をまとめました: ${f}` : '音の元が何もないので、音なしのままにします。');
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
