// ナレーションの音声づくり。各行を audio/narration/<id>.wav にし、時刻表を新しい声の長さに合わせ直す（伸ばしも縮めもする。retime.mjs）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { geminiTts, recordModel, requireApproval, requireConsent } from './gemini.mjs';
import { beginRun } from './lock.mjs';
import { isMain, removeTree, replaceFile } from './paths.mjs';
import { readProject, writeProject } from './project.mjs';
import { applyReadings, readReadings } from './readings.mjs';
import { retimeTable, retimeToVoices } from './retime.mjs';
import { holdHint, holdViolations, narrationOverlaps, overlapMessage, validateTimeline, writeTimeline } from './timeline.mjs';
import { characterTerms, checkScales, DEFAULT_INTONATION, DEFAULT_SPEED, DEFAULT_VOICE, resolveSpeaker, voicevoxSpeak } from './voicevox.mjs';
import { readWavBuffer } from './wav.mjs';

export { NOTICE_EXTERNAL_API } from './gemini.mjs';

const round = (x) => Math.round(x * 1000) / 1000;

/**
 * @param {string} projectDir
 * @param {{engine: 'voicevox'|'gemini', speakerOrVoice?: number|string, speed?: number, intonation?: number, approved?: boolean,
 *   fetch?: typeof fetch, base?: string, apiKey?: string, warn?: (message: string) => void, log?: (message: string) => void}} opts
 *   speakerOrVoice は、VOICEVOX なら声の番号か「名前/スタイル」（省くと DEFAULT_VOICE）、Gemini なら声の名前
 *   approved は Gemini（有料）だけで使う。利用者がこの実行（回数と目的）に了承したときだけ true
 *   force は、声・速さ・抑揚・文が前と同じ行も作り直す（別の読み方を試すとき。Gemini は同じ文でも毎回読み方が変わる）
 *   speed と intonation は VOICEVOX だけで使う（話す速さ 0.5〜2.0、抑揚 0〜2.0。省くと DEFAULT_SPEED と DEFAULT_INTONATION）
 *   warn は、合わせ直した後に確かめ直すこと（BGM、読み切れない文字など）の知らせ先（既定は console.warn）
 *   log は、シーンごとの長さの表の出し先（既定は console.log）
 */
export async function synthesizeNarration(projectDir, { engine, speakerOrVoice, speed, intonation, approved, force = false, fetch: f = fetch, base, apiKey, warn = console.warn, log = console.log }) {
  const project = readProject(projectDir);
  if (engine === 'gemini') requireConsent(project);
  else if (engine !== 'voicevox') throw new Error(`知らない読み上げ方法です: ${engine}（voicevox か gemini）`);
  if (engine === 'voicevox') {
    checkScales({ speed, intonation });
    speakerOrVoice ??= DEFAULT_VOICE;
    speed ??= DEFAULT_SPEED;
    intonation ??= DEFAULT_INTONATION;
  } else if (speakerOrVoice == null) throw new Error('--voice が必要です');
  else if (speed !== undefined || intonation !== undefined) throw new Error('--speed と --intonation は VOICEVOX だけで使えます。');

  // 読みの辞書は、何か作る前に読む（形が違えば何も作らずに止める）
  const readings = readReadings(projectDir);
  const tlFile = path.join(projectDir, 'timeline.json');
  const before = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  // id はファイル名に使うので、何か作る前に時刻表を確かめる（../ などで制作フォルダの外に書かない。有料の了承を求める前に止める）
  const checked = validateTimeline(before);
  if (!checked.ok) throw new Error(`timeline.json に誤りがあります。直してから実行してください:\n${checked.errors.map((m) => `- ${m}`).join('\n')}`);
  const dir = path.join(projectDir, 'audio', 'narration');
  fs.mkdirSync(dir, { recursive: true });

  // 全行を合成してから、元の時刻表と新しい声の長さから一度に合わせ直す。
  // 合成した声はいったん audio/.narration-partial/ に置き、全行そろってから入れ替える（途中で失敗しても、前の声と時刻表は変わらない）。
  // 声・速さ・抑揚・読み上げる文が前と同じ行は使い回し、変わった行だけを作る。前の実行で作り終えた行（audio/narration/ と、
  // その鍵の記録 .manifest.json）と、途中で失敗した実行が残した行（audio/.narration-partial/）のどちらも使う
  // （Gemini は行ごとに課金され、同じ文でも毎回読み方が変わるので、1 行直すたびに了承済みの行まで読み直さない。了承に見せる回数も作る行数にする）
  const staging = path.join(projectDir, 'audio', '.narration-partial');
  fs.mkdirSync(staging, { recursive: true });
  const manifestFile = path.join(staging, 'manifest.json');
  const doneFile = path.join(dir, '.manifest.json');
  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  /** @type {Record<string, string>} 行の id → 合成したときの条件の鍵（途中の置き場の分） */
  const manifest = force ? {} : readJson(manifestFile);
  /** @type {Record<string, string>} 行の id → 合成したときの条件の鍵（作り終えた audio/narration/ の分） */
  const done = force ? {} : readJson(doneFile);
  // 読み上げに渡す文だけを辞書で置き換える（原稿と字幕は元の文のまま）
  const spokenOf = (line) => applyReadings(line.text, readings);
  const keyOf = (line, who) => crypto.createHash('sha256').update(JSON.stringify([engine, who, speed ?? null, intonation ?? null, spokenOf(line)])).digest('hex');
  /** 使い回せる声のファイル（無ければ null） */
  const reusableFile = (line, who) => {
    const key = keyOf(line, who);
    const staged = path.join(staging, `${line.id}.wav`);
    if (manifest[line.id] === key && fs.existsSync(staged)) return staged;
    const final = path.join(dir, `${line.id}.wav`);
    if (done[line.id] === key && fs.existsSync(final)) return final;
    return null;
  };
  const reusable = (line, who) => reusableFile(line, who) !== null;

  if (engine === 'gemini') {
    const todo = before.narration.filter((l) => !reusable(l, String(speakerOrVoice)));
    const kept = before.narration.length - todo.length;
    const chars = todo.reduce((n, l) => n + [...l.text].length, 0);
    if (todo.length) {
      log(requireApproval(approved, { calls: todo.length, purpose: `ナレーション ${todo.length} 行・${chars} 文字の読み上げ${kept ? `。声と文が前と同じ ${kept} 行は使い回す` : '。全行を作る'}` }));
    }
  }

  // 声の番号とクレジット用の話者名は、書き始める前に引いておく（分からなければ何も作らずに止める）
  const voice = engine === 'voicevox' ? await resolveSpeaker(speakerOrVoice, { base, fetch: f }) : null;
  const who = voice ? voice.id : String(speakerOrVoice);

  const durations = {};
  let made = 0;
  try {
    for (const line of before.narration) {
      const id = line.id;
      const file = path.join(staging, `${id}.wav`);
      const old = reusableFile(line, who);
      if (old) {
        durations[id] = round(readWavBuffer(fs.readFileSync(old)).duration);
        continue;
      }
      const spoken = spokenOf(line);
      const wav = engine === 'voicevox'
        ? await voicevoxSpeak(spoken, { speaker: voice.id, speed, intonation, base, fetch: f })
        : await geminiTts(spoken, { voice: String(speakerOrVoice), apiKey, fetch: f });
      durations[id] = round(readWavBuffer(wav).duration);
      fs.writeFileSync(file, wav);
      manifest[id] = keyOf(line, who);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
      made++;
    }
  } catch (e) {
    const kept = before.narration.filter((l) => reusable(l, who)).length;
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(done
      ? `${msg}\n合成済みの ${kept} 行は残しました。もう一度実行すると、残りの行だけを作ります（前の声と時刻表は変えていません）。`
      : msg);
  }
  const { tl: retimed, rows, warnings } = retimeToVoices(before, durations);
  try {
    // 置き場から入れる行は、入れ替えの前に作り終えた分の記録から外す（途中で止まっても、入れかけの声を前と同じものとして使い回さない。
    // その行は置き場に残るので、次の実行は置き場から入れ直す）
    const moving = new Set(before.narration.filter((l) => manifest[l.id] === keyOf(l, who) && fs.existsSync(path.join(staging, `${l.id}.wav`))).map((l) => l.id));
    fs.writeFileSync(doneFile, JSON.stringify(Object.fromEntries(Object.entries(done).filter(([id]) => !moving.has(id))), null, 2) + '\n');
    for (const line of before.narration) {
      // 作り終えた声を使い回した行は、もう audio/narration/ にあるので動かさない
      if (!moving.has(line.id)) continue;
      const staged = path.join(staging, `${line.id}.wav`);
      // 置き場の写しを入れる（入れ替えの後で、途中の置き場をまとめて消す）
      fs.copyFileSync(staged, `${staged}.move`);
      replaceFile(`${staged}.move`, path.join(dir, `${line.id}.wav`));
    }
    fs.writeFileSync(doneFile, JSON.stringify(Object.fromEntries(before.narration.map((l) => [l.id, keyOf(l, who)])), null, 2) + '\n');
  } catch (e) {
    // 合成した声は途中の置き場に残っているので、もう一度実行すれば作り直さずに入れ替えと時刻の合わせ直しをやり直せる
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n声の入れ替えの途中で止まりました（一部の声だけが新しく、時刻表はまだ前のままです）。ファイルを開いているソフトを閉じて、同じコマンドをもう一度実行してください。合成した声は残してあるので、作り直さずに入れ替えをやり直します（有料の API も呼びません）。`);
  }
  removeTree(staging);
  const tl = { ...retimed, narration: retimed.narration.map((n) => ({ ...n, audio: `audio/narration/${n.id}.wav` })) };

  writeTimeline(projectDir, tl);
  // 作り直すときに同じ読みになるよう、辞書を使ったことを残す（中身は制作フォルダの audio/readings.json）
  const dict = readings.length ? { readings: readings.length } : {};
  if (voice) {
    const p = readProject(projectDir);
    p.credits = [...new Set([...(p.credits ?? []), `VOICEVOX:${voice.name}`])];
    writeProject(projectDir, p);
    // 作り直すときに同じ声と読み方を選べるよう、声（名前/スタイル）と番号と値を残す
    // 規約の場所と確かめた日も残す（権利の一覧に出す）
    const { terms, checked: termsChecked } = characterTerms(voice.name);
    recordModel(projectDir, { kind: 'tts', model: 'voicevox', speaker: voice.id, character: voice.name, style: voice.style, voice: `${voice.name}/${voice.style}`, speed, intonation, terms, termsChecked, ...dict });
  } else {
    recordModel(projectDir, { kind: 'tts', model: 'gemini-3.8-flash-tts', voice: String(speakerOrVoice), ...dict });
  }
  log(retimeTable(rows));
  // 合わせ直した後も残る問題（timeline.mjs validate と同じもの）と、BGM の確かめ直しを知らせる
  const problems = [
    ...validateTimeline(tl).errors,
    ...holdViolations(tl).map((h) => `テキスト ${h.id} の表示が ${round(h.actual)} 秒しかありません（読み切るには ${h.need} 秒以上）${holdHint(h)}`),
    ...narrationOverlaps(tl).map(overlapMessage),
  ];
  for (const m of [...warnings, ...problems.map((p) => `注意: ${p.replace(/。$/, '')}。`)]) warn(m);
  return tl;
}

if (isMain(import.meta.url)) {
  const [dir, ...rest] = process.argv.slice(2);
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    const v = i >= 0 ? rest[i + 1] : undefined;
    return v === undefined || v.startsWith('--') ? undefined : v; // 次のフラグ（--approved など）を値として食わない
  };
  try {
    if (!dir) {
      throw new Error('使い方: node narration.mjs <制作フォルダ> [--engine voicevox] [--speaker <番号か 名前/スタイル>] [--speed 1.1] [--intonation 1.2] [--force]'
        + ' / --engine gemini --voice Kore [--approved] [--force]（--force は、前と同じ行も作り直す）');
    }
    const engine = opt('engine') ?? 'voicevox';
    const who = engine === 'gemini' ? opt('voice') : opt('speaker'); // VOICEVOX は省くと既定の声
    if (engine === 'gemini' && who == null) throw new Error('--voice が必要です');
    const num = (v) => (v === undefined ? undefined : Number(v));
    // 時刻表を書き換えるので、書き出し・点検と重ねない
    beginRun(dir, 'narration.mjs');
    const tl = await synthesizeNarration(dir, { engine, speakerOrVoice: who, speed: num(opt('speed')), intonation: num(opt('intonation')), approved: rest.includes('--approved'), force: rest.includes('--force') });
    console.log(`ナレーション ${tl.narration.length} 行を書きました`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
