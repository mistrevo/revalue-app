// 効果音の合成（Node だけ。正弦波・ノイズ・包絡の組み合わせ）と、タイムラインへの配置。
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './paths.mjs';
import { writeWav } from './wav.mjs';

export const SFX_PRESETS = ['pop', 'click', 'whoosh', 'hit', 'riser', 'chime', 'tick', 'swoosh-out'];

const SR = 48000;

/** 種から決まる乱数（mulberry32） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const n = (sec) => Math.round(sec * SR);
/** 指数減衰。tau 秒で 1/e */
const decay = (t, tau) => Math.exp(-t / tau);
/** 立ち上がり a 秒の線形フェード（先頭のクリックを防ぐ） */
const attack = (t, a) => Math.min(1, t / a);
/** 一次ローパス（高域が耳に刺さらないように。cutoff は毎サンプル変えられる） */
function lowpass() {
  let y = 0;
  return (x, cutoff) => {
    const k = 1 - Math.exp((-TAU * cutoff) / SR);
    y += k * (x - y);
    return y;
  };
}

/** 各プリセットの 1 チャンネル分。ノイズ系は左右で違う乱数列になる */
const GEN = {
  pop(len) {
    const out = new Float32Array(len);
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      ph += (TAU * (240 + 420 * decay(t, 0.03))) / SR;
      out[i] = Math.sin(ph) * decay(t, 0.05) * attack(t, 0.002) * 0.7;
    }
    return out;
  },
  click(len, r) {
    const out = new Float32Array(len);
    const lp = lowpass();
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const noise = lp(r() * 2 - 1, 5000) * decay(t, 0.004);
      out[i] = (noise * 0.6 + Math.sin(TAU * 1800 * t) * decay(t, 0.008) * 0.4) * attack(t, 0.0005) * 0.8;
    }
    return out;
  },
  whoosh(len, r) {
    const out = new Float32Array(len);
    const lp = lowpass();
    const dur = len / SR;
    for (let i = 0; i < len; i++) {
      const p = i / SR / dur;
      const env = Math.sin(Math.PI * p) ** 2;
      out[i] = lp(r() * 2 - 1, 400 + 3600 * Math.sin(Math.PI * p)) * env * 1.6;
    }
    return out;
  },
  hit(len, r) {
    const out = new Float32Array(len);
    const lp = lowpass();
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      ph += (TAU * (45 + 70 * decay(t, 0.04))) / SR;
      const thump = Math.sin(ph) * decay(t, 0.12);
      const body = lp(r() * 2 - 1, 1500) * decay(t, 0.025);
      out[i] = (thump * 0.85 + body * 0.5) * attack(t, 0.001) * 0.9;
    }
    return out;
  },
  riser(len, r) {
    const out = new Float32Array(len);
    const lp = lowpass();
    const dur = len / SR;
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const p = t / dur;
      ph += (TAU * (220 + 660 * p * p)) / SR;
      const env = (0.03 + 0.97 * p * p) * attack(t, 0.005);
      const noise = lp(r() * 2 - 1, 300 + 3500 * p);
      out[i] = (noise * 0.9 + Math.sin(ph) * 0.35) * env * 0.8;
    }
    return out;
  },
  chime(len) {
    const out = new Float32Array(len);
    const partials = [[880, 1, 0.35], [1318.5, 0.6, 0.28], [1760, 0.35, 0.2]];
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      let v = 0;
      for (const [f, a, tau] of partials) v += Math.sin(TAU * f * t) * a * decay(t, tau);
      out[i] = v * attack(t, 0.002) * 0.4;
    }
    return out;
  },
  tick(len) {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      out[i] = Math.sin(TAU * 1200 * t) * decay(t, 0.006) * attack(t, 0.0008) * 0.6;
    }
    return out;
  },
  'swoosh-out'(len, r) {
    const out = new Float32Array(len);
    const lp = lowpass();
    const dur = len / SR;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const p = t / dur;
      const env = attack(t, 0.01) * (1 - p) ** 2;
      out[i] = lp(r() * 2 - 1, 300 + 3000 * (1 - p)) * env * 1.8;
    }
    return out;
  },
};

/** プリセットごとの長さ（秒） */
const LENGTH = { pop: 0.25, click: 0.06, whoosh: 0.55, hit: 0.45, riser: 1.0, chime: 0.9, tick: 0.05, 'swoosh-out': 0.4 };

/** 1 本あたりの最大ピーク。1.0 に届かせない */
const PEAK = 0.85;

/**
 * 効果音を 48kHz ステレオで合成する。同じ seed なら同じ波形。
 * @param {string} preset
 * @param {{seed?: number}} [opts]
 * @returns {Float32Array[]}
 */
export function synthSfx(preset, { seed = 1 } = {}) {
  if (!SFX_PRESETS.includes(preset)) throw new Error(`知らない効果音です: ${preset}（${SFX_PRESETS.join('、')} のいずれか）`);
  const len = n(LENGTH[preset]);
  const chans = [0, 1].map((ch) => GEN[preset](len, rng((seed * 2654435761 + ch * 97 + 1) >>> 0)));
  // 末尾 5ms をフェードして切れ目のクリックを防ぎ、ピークを PEAK に揃える
  const tail = n(0.005);
  let peak = 0;
  for (const c of chans) {
    for (let i = 0; i < tail; i++) c[len - 1 - i] *= i / tail;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(c[i]));
  }
  const k = peak > 0 ? PEAK / peak : 1;
  for (const c of chans) for (let i = 0; i < len; i++) c[i] *= k;
  return chans;
}

/**
 * timeline の効果音を 1 本の WAV に並べる。置く時刻は「映像のイベントの 1 フレーム後」(t + 1/fps)。
 * 重なって大きくなりすぎる場合は全体を下げて 0.98 に収める。
 * @param {{fps: number, seed?: number, sfx: Array<{id: string, t: number, preset: string, gain?: number}>}} tl
 * @param {string} file
 */
export function renderSfxTrack(tl, file) {
  const items = tl.sfx.map((x, i) => ({
    wave: synthSfx(x.preset, { seed: (tl.seed ?? 1) + i }),
    gain: 10 ** ((x.gain ?? 0) / 20),
    at: Math.round((x.t + 1 / tl.fps) * SR),
  }));
  const total = items.reduce((m, it) => Math.max(m, it.at + it.wave[0].length), 0) + n(0.1);
  const out = [new Float32Array(total), new Float32Array(total)];
  for (const it of items) {
    for (let c = 0; c < 2; c++) for (let i = 0; i < it.wave[c].length; i++) out[c][it.at + i] += it.wave[c][i] * it.gain;
  }
  let peak = 0;
  for (const c of out) for (const v of c) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.98) for (const c of out) for (let i = 0; i < total; i++) c[i] *= 0.98 / peak;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeWav(file, { sampleRate: SR, channels: 2, data: out });
}

if (isMain(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('使い方: node sfx.mjs <制作フォルダ>');
    process.exit(1);
  }
  const tl = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  const out = path.join(dir, 'audio', 'sfx.wav');
  renderSfxTrack(tl, out);
  console.log(`効果音 ${tl.sfx.length} 件を書きました: ${out}`);
}
