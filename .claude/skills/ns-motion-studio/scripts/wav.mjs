// PCM16 の WAV 読み書き（効果音・ナレーション・BGM で共有）。
import fs from 'node:fs';

/**
 * @typedef {{sampleRate: number, channels: number, data: Float32Array[]}} Pcm
 */

/** Float32（-1〜1）の各チャンネルを PCM16 の WAV として書く */
export function writeWav(file, { sampleRate, channels, data }) {
  const frames = data[0]?.length ?? 0;
  const body = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      body.writeInt16LE(Math.round(v * 32767), (i * channels + c) * 2);
    }
  }
  fs.writeFileSync(file, pcm16ToWav(body, { sampleRate, channels }));
}

/**
 * ヘッダなしの PCM16（リトルエンディアン、インターリーブ）に WAV のヘッダを付ける。
 * @param {Buffer} buf
 */
export function pcm16ToWav(buf, { sampleRate = 24000, channels = 1 } = {}) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + buf.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(buf.length, 40);
  return Buffer.concat([h, buf]);
}

/** WAV（PCM16 のみ）をバッファから読む。fmt と data 以外のチャンクは飛ばす */
export function readWavBuffer(b) {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('WAV ではありません');
  }
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('latin1', pos, pos + 4);
    let size = b.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(start), channels: b.readUInt16LE(start + 2), sampleRate: b.readUInt32LE(start + 4), bits: b.readUInt16LE(start + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV の fmt がありません');
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('PCM16 以外の WAV は読めません');
      size = Math.min(size, b.length - start); // 長さが不正でも読める範囲まで読む
      const frames = Math.floor(size / (fmt.channels * 2));
      const data = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++) data[c][i] = b.readInt16LE(start + (i * fmt.channels + c) * 2) / 32768;
      }
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, data, duration: frames / fmt.sampleRate };
    }
    pos = start + size + (size % 2);
  }
  throw new Error('WAV の data がありません');
}

/** @returns {Pcm & {duration: number}} */
export function readWav(file) {
  return readWavBuffer(fs.readFileSync(file));
}
