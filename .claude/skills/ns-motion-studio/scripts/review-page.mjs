// 関門ごとの確認ページ（spec 5章）。reviews/<関門>.html に、サーバーなしで開ける単一の HTML を書く。
// 画像と動画は reviews/ からの相対パスで参照し、外部（http/https）のものは何も読み込まない。
// 利用者はカットごとの欄に指摘を書き（ブラウザに一時保存）、「指摘をまとめてコピー」でチャットに貼る。
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readIntentSeen, readWaivers, videoPath, waiverMatches } from './check.mjs';
import { readFeedbackLog } from './feedback.mjs';
import { isMain, replaceFile } from './paths.mjs';
import { briefingFile, normalizeName, readProject } from './project.mjs';
import { ratioDir } from './render.mjs';
import { readTimeline, settledTime } from './timeline.mjs';
import { characterTerms } from './voicevox.mjs';

/** @typedef {'briefing'|'style'|'storyboard'|'plan'|'rough'|'deliver'} Gate */

/** 関門と、ページの見出しに出す名前 */
export const GATE_LABELS = {
  briefing: '関門1　ブリーフィングの確認',
  style: 'スタイルの選択',
  storyboard: '関門2　絵コンテとテロップ',
  plan: '構成の確認',
  rough: '関門3　ラフ版',
  deliver: '納品の確認',
};

/** ページの冒頭の説明（関門ごと） */
const LEADS = {
  briefing: '動画の目的と内容、受け取った素材をまとめました。違っているところや足りないものがあれば、下の欄に書いてください。',
  style: '見た目の案を並べました。いちばん近い案を選び、気になるところがあれば下の欄に書いてください。',
  storyboard: 'カットごとの流れと、テロップ・ナレーションの原稿です。文字はここで確定します。言い回しや順番を確かめてください。',
  plan: '書き出しの前に、要件・見た目・カットごとの流れと文字をまとめて確かめてください。ここで直すと、書き出し直しの時間がかかりません。',
  rough: '画質を落とした試作版です。動きの流れと文字の内容を見てください（画質は完成版で上がります）。カットの番号を押すと、その場面から再生します。',
  deliver: '完成版です。動画、ポスター画像、使った素材と権利の一覧を、最後に確かめてください。',
};

/** 書き方の案内（全関門で共通） */
const HOWTO = '書いた内容はこのブラウザに自動で保存されます。書き終えたら「指摘をまとめてコピー」を押し、チャットに貼り付けてください。直すところがなければ、チャットで「OK」とだけ伝えてください。';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);

// ---- 文字の整形（ページの中でも同じ関数を使う。外の変数に頼らないこと） ----

/**
 * 秒を「0:05」の形にする。十分の一秒があれば「0:01.5」。
 * @param {number} t
 */
export function formatClock(t) {
  const tenths = Math.round(Math.max(t, 0) * 10);
  const m = Math.floor(tenths / 600);
  const rest = tenths % 600;
  const s = String(Math.floor(rest / 10)).padStart(2, '0');
  return m + ':' + s + (rest % 10 ? '.' + (rest % 10) : '');
}

/**
 * 「指摘をまとめてコピー」で作る文。1 行目は見出し、あとは 1 指摘 1 行（改行は「 / 」でつなぐ）。
 * @param {string} title
 * @param {string} gate
 * @param {Array<{cut: number|null, start?: number, end?: number, text: string}>} items
 */
export function copyText(title, gate, items) {
  const oneLine = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(' / ');
  const lines = ['[ns-motion-studio 指摘] ' + title + ' / ' + gate];
  for (const it of items) {
    let where = '全体';
    if (it.cut != null) {
      where = 'カット' + it.cut;
      if (it.start != null && it.end != null) where += '（' + formatClock(it.start) + '〜' + formatClock(it.end) + '）';
    }
    lines.push(where + '：' + oneLine(it.text));
  }
  return lines.join('\n');
}

// ---- HTML の部品 ----

/** HTML の特殊文字を逃がす */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 秒の長さ（1.5秒） */
const duration = (s) => `${Math.round(s * 10) / 10}秒`;

/** 色見本つきで、行内の書式（`code`、**太字**、[文字](リンク)）を組む。リンクは文字だけ残す */
function inline(text) {
  const swatch = (s) => s.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => `<span class="sw" style="background:${hex}"></span>${hex}`);
  return text.split(/(`[^`]+`)/).map((part) => {
    if (/^`[^`]+`$/.test(part)) return `<code>${swatch(esc(part.slice(1, -1)))}</code>`;
    const plain = esc(part)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return swatch(plain);
  }).join('');
}

/**
 * 利用者向けの Markdown（briefing.md、style.md、rights.md など）を HTML にする。
 * 見出し・箇条書き・番号つき・表・段落・コードの囲みだけを扱い、文字はすべて逃がす。
 * 字下げした箇条は、その上の項目の中の入れ子の箇条にする（字下げの深さで段を決める）。
 * 見出しは、ページの節（h2）の下に入るよう 2 段下げる（# は h3）。
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdown(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  /** 開いている箇条の段（外から順に）。各段の最後の <li> は開いたまま */
  const lists = [];
  const closeList = () => out.push(`</li></${lists.pop().type}>`);
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
    while (lists.length) closeList();
  };
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^\s*```/.test(line)) {
      flush();
      const body = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
      out.push(`<pre>${esc(body.join('\n'))}</pre>`);
    } else if (!line.trim()) {
      flush();
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flush();
      const level = Math.min(m[1].length + 2, 6);
      out.push(`<h${level}>${inline(m[2].trim())}</h${level}>`);
    } else if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush();
      const head = cells(line);
      i++;
      const rows = [];
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if ((m = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.*)$/))) {
      const type = m[1] ? 'ul' : 'ol';
      const indent = line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
      if (para.length) flush();
      while (lists.length && lists.at(-1).indent > indent) closeList();
      let top = lists.at(-1);
      if (top && top.indent === indent && top.type !== type) { closeList(); top = lists.at(-1); }
      if (top && top.indent === indent) {
        out.push(`</li><li>${inline(m[2])}`);
      } else {
        // 段が無い、または上の項目より深い字下げ: 新しい箇条を開く（深ければ上の項目の中に入る）
        out.push(`<${type}><li>${inline(m[2])}`);
        lists.push({ type, indent });
      }
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
    } else {
      if (lists.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join('\n');
}

/**
 * Markdown から、見出しに「不足」を含む節を抜き出す。
 * @param {string} md
 * @returns {{rest: string, missing: string[]}} rest は不足の節を除いた残り、missing はその節の箇条
 */
function splitMissing(md) {
  const { rest, items } = splitSection(md, (h) => h.includes('不足'));
  // 「なし」だけの節は、不足が無いという意味（警告の枠を出さない）
  const none = items.length === 1 && /^(?:なし|無し|ありません|特になし)[。.]?$/.test(items[0]);
  return { rest, missing: none ? [] : items };
}

/**
 * Markdown から、見出しが match に当たる節を抜き出す（最初に当たった節から、同じか上の段の見出しまで）。
 * @param {string} md
 * @param {(heading: string) => boolean} match
 * @returns {{rest: string, items: string[]}} rest はその節を除いた残り、items はその節の箇条（箇条でない行もそのまま）
 */
function splitSection(md, match) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const rest = [];
  const items = [];
  let level = 0;
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h && level && h[1].length <= level) level = 0;
    if (h && !level && match(h[2])) {
      level = h[1].length;
      continue;
    }
    if (!level) {
      rest.push(line);
      continue;
    }
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (item) items.push(item[1].trim());
    else if (line.trim()) items.push(line.trim());
  }
  return { rest: rest.join('\n'), items };
}

// ---- 制作フォルダから読む ----

/** ファイルを読む。無ければ null */
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/** ディレクトリの中のファイルを、隠しファイルを除いて再帰的に並べる（名前順） */
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * 利用者から受け取った素材（assets/ の中身）。fonts.mjs が取り込んだ書体（assets/fonts/）は、
 * 道具が作ったもので数百のファイルになるため除く（書体は権利一覧で書体名として扱う）。
 */
function receivedAssets(projectDir) {
  const root = path.join(projectDir, 'assets');
  const fonts = path.join(root, 'fonts') + path.sep;
  return listFiles(root).filter((f) => !f.startsWith(fonts));
}

/**
 * assets/fonts/fonts.css から、取り込んだ書体の名前と太さ（例: 「Noto Sans JP（400、700）」）と出どころを読む。
 * 出どころは fonts.mjs が書く記録（ns-motion-studio: family="…" source="…" license="…"）から。無ければ null
 * @returns {{name: string, source: string|null}[]}
 */
function fontFamilies(projectDir) {
  const css = readText(path.join(projectDir, 'assets/fonts/fonts.css'));
  if (!css) return [];
  const sources = new Map();
  for (const m of css.matchAll(/ns-motion-studio:\s*family="([^"]+)"\s+source="([^"]+)"\s+license="([^"]*)"/g)) {
    sources.set(m[1], m[3] ? `${m[2]}（${m[3]}）` : m[2]);
  }
  const fams = new Map();
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const fam = m[1].match(/font-family:\s*['"]?([^;'"]+)['"]?/)?.[1]?.trim();
    const w = m[1].match(/font-weight:\s*([^;]+);/)?.[1]?.trim();
    if (!fam) continue;
    if (!fams.has(fam)) fams.set(fam, new Set());
    if (w) fams.get(fam).add(w);
  }
  return [...fams].map(([f, ws]) => ({
    name: ws.size ? `${f}（${[...ws].sort().join('、')}）` : f,
    source: sources.get(f) ?? null,
  }));
}

/** ファイルの大きさを読みやすく */
function fileSize(file) {
  const n = fs.statSync(file).size;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 1 カットの代表スチル。reviews/frames/<比率>/t-*.png のうち、カットの落ち着いた時刻（frames.mjs beats が撮る時刻）にいちばん近いもの。
 * @returns {string|null} 絶対パス
 */
function cutStill(projectDir, tl, ratio, scene) {
  const dir = path.join(projectDir, 'reviews/frames', ratioDir(ratio));
  if (!fs.existsSync(dir)) return null;
  const mid = settledTime(tl, scene);
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^t-(\d+(?:\.\d+)?)\.png$/);
    if (!m) continue;
    const t = Number(m[1]);
    if (t < scene.start || t >= scene.end) continue;
    if (!best || Math.abs(t - mid) < Math.abs(best.t - mid)) best = { t, file: path.join(dir, name) };
  }
  return best?.file ?? null;
}

/** 自動点検の結果（reviews/checks-<段階>-<比率>.json）。無ければ空 */
function checkFindings(projectDir, stage, ratio) {
  const file = path.join(projectDir, 'reviews', `checks-${stage}-${ratioDir(ratio)}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).findings ?? [];
  } catch {
    return [];
  }
}

// ---- ページの部品 ----

/**
 * @typedef {{projectDir: string, reviewsDir: string, gate: Gate, title: string,
 *   tl: import('./timeline.mjs').Timeline|null, project: any, rel: (file: string) => string}} Ctx
 */

/** 前回の指摘と対応 */
function previousSection(ctx) {
  const { items } = readFeedbackLog(ctx.projectDir);
  if (!items.length) return '';
  const done = items.filter((i) => i.resolved).length;
  const rows = items.map((it) => {
    const where = it.cut == null ? '全体' : `カット${it.cut}${it.start != null && it.end != null ? `（${formatClock(it.start)}〜${formatClock(it.end)}）` : ''}`;
    const state = it.resolved
      ? `<p class="how"><span class="pill ok">対応済み</span>${esc(it.resolved.how)}</p>`
      : '<p class="how"><span class="pill wait">未対応</span>次の版で直します</p>';
    return `<li><p class="said"><span class="where">${esc(where)}</span><span class="gate">${esc(GATE_LABELS[normalizeName(it.gate)] ?? it.gate)}</span></p><p>${esc(it.text)}</p>${state}</li>`;
  }).join('');
  // 動画を主役にするため畳んでおく（見出しの行に件数と対応数を出す）
  return `<details class="card prev"><summary><h2>前回の指摘と対応</h2>
<span class="muted">${items.length}件のうち${done}件に対応しました</span></summary><ul class="prev-list">${rows}</ul></details>`;
}

/** コメント欄 */
function commentBox(key, label, placeholder) {
  const id = `c-${key}`;
  return `<div class="comment"><label for="${id}">${esc(label)}</label><textarea id="${id}" data-key="${esc(key)}" rows="3" placeholder="${esc(placeholder)}"></textarea></div>`;
}

/**
 * カットごとの欄（絵コンテ・ラフ版・納品）。
 * @param {Ctx} ctx
 * @param {{jump: boolean, stage?: 'build'|'final', board?: Map<number, string>}} opts jump: 番号を押すと再生位置へ飛ぶ。stage: 自動点検の結果を出す段階。board: storyboard.md のカットの節
 */
function cutList(ctx, { jump, stage, board }) {
  const tl = ctx.tl;
  // 比率が複数なら、どの比率も見せる（9:16 などは組み直したレイアウトなので、16:9 の静止画では確かめられない）
  const ratios = tl.ratios?.length ? tl.ratios : ['16:9'];
  const multi = ratios.length > 1;
  const findings = stage
    ? ratios.flatMap((r) => checkFindings(ctx.projectDir, stage, r).filter((f) => !f.waived).map((f) => ({ ...f, message: multi ? `${r}: ${f.message}` : f.message })))
    : [];
  return tl.scenes.map((scene, i) => {
    const cut = i + 1;
    const time = `${formatClock(scene.start)}〜${formatClock(scene.end)}`;
    const head = `<span class="no">カット ${cut}</span><span class="time">${time}<span class="len">（${duration(scene.end - scene.start)}）</span></span>`;
    const headHtml = jump
      ? `<button type="button" class="jump" data-jump="${scene.start}" aria-label="カット${cut}（${time}）から再生">${head}<span class="play" aria-hidden="true">▶</span></button>`
      : `<div class="jump static">${head}</div>`;
    const stills = ratios.map((r) => ({ r, file: cutStill(ctx.projectDir, ctx.tl, r, scene) })).filter((s) => s.file);
    const figure = ({ r, file }) => {
      const a = aspect(r);
      return `<figure class="thumb"${a ? ` style="flex:${a.w / a.h} 1 0"` : ''}><img src="${ctx.rel(file)}" alt="カット${cut}の静止画（${esc(r)}）" loading="lazy">${
        multi ? `<figcaption>${esc(r)}</figcaption>` : ''}</figure>`;
    };
    const thumb = stills.length
      ? (multi ? `<div class="thumbs">${stills.map(figure).join('')}</div>` : figure(stills[0]))
      : (stage ? '' : '<figure class="thumb empty"><span>静止画はまだありません</span></figure>');
    const narr = (tl.narration ?? []).filter((n) => n.scene === scene.id);
    // ナレーションと同じ文の字幕（空白の違いは問わない）は、テロップに二重に並べず、ナレーションの行に時刻を添える
    const same = (a, b) => a.replace(/\s/g, '') === b.replace(/\s/g, '');
    /** @type {Map<any, any[]>} ナレーションの行ごとの、同じ文の字幕 */
    const subsOf = new Map(narr.map((n) => [n, []]));
    const texts = tl.texts.filter((t) => {
      if (t.scene !== scene.id) return false;
      const n = t.kind === 'subtitle' ? narr.find((x) => same(x.text, t.text)) : undefined;
      if (n) subsOf.get(n).push(t);
      return !n;
    });
    const subTag = (n) => subsOf.get(n).map((t) => `<span class="tag">字幕も同文 ${formatClock(t.start)}〜${formatClock(t.end)}</span>`).join('');
    const words = [
      texts.length ? `<dt>テロップ</dt>${texts.map((t) => `<dd><span class="say">${esc(t.text)}</span><span class="at">${formatClock(t.start)}〜${formatClock(t.end)}</span></dd>`).join('')}` : '',
      narr.length ? `<dt>ナレーション</dt>${narr.map((n) => `<dd><span class="say">${esc(n.text)}</span><span class="at">${formatClock(n.start)}〜</span>${subTag(n)}</dd>`).join('')}` : '',
    ].join('');
    const last = i === tl.scenes.length - 1;
    const sfx = (tl.sfx ?? []).filter((x) => x.t >= scene.start && (x.t < scene.end || (last && x.t <= scene.end)));
    const sfxHtml = sfx.length
      ? `<dl><dt>効果音</dt>${sfx.map((x) => `<dd><span class="say">${esc(x.preset)}</span><span class="at">${formatClock(x.t)}</span></dd>`).join('')}</dl>`
      : '';
    const boardHtml = board?.get(cut) ? `<div class="doc board">${renderMarkdown(board.get(cut))}</div>` : '';
    const notes = findings.filter((f) => f.cut === cut && !f.intended);
    const notesHtml = notes.length
      ? `<div class="notes"><p>機械の点検で気づいたこと</p><ul>${notes.map((f) => `<li>${esc(f.message)}</li>`).join('')}</ul></div>`
      : '';
    // 既定から外した演出（意図どおり）は、直すものと分けて出す
    const meant = findings.filter((f) => f.cut === cut && f.intended);
    const meantHtml = meant.length
      ? `<div class="notes meant"><p>意図どおり（既定から外した演出）</p><ul>${meant.map((f) => `<li>${esc(f.message)}${f.intendedWhy ? `<span class="muted">（${esc(f.intendedWhy)}）</span>` : ''}</li>`).join('')}</ul></div>`
      : '';
    return `<article class="cut" data-cut="${cut}" id="cut-${cut}">
<div class="cut-head">${headHtml}${scene.purpose ? `<p class="purpose">${esc(scene.purpose)}</p>` : ''}</div>
<div class="cut-body">${thumb}<div class="words">${words ? `<dl>${words}</dl>` : '<p class="muted">このカットに文字はありません。</p>'}${sfxHtml}${boardHtml}${notesHtml}${meantHtml}</div>
${commentBox(String(cut), `カット${cut}への指摘`, '例：テロップの文字をもう少し大きく')}</div>
</article>`;
  }).join('\n');
}

/**
 * 'W:H' の縦横比。形が違えば null（timeline の検証を通っていれば起きないが、flex:NaN を出さないため）
 * @param {string} ratio
 */
function aspect(ratio) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(ratio));
  return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** 比率ごとのプレーヤー。動画が無ければ、その旨を出す */
function players(ctx, preset) {
  return `<div class="players${ctx.tl.ratios.length > 1 ? ' multi' : ''}">${ctx.tl.ratios.map((ratio) => {
    const file = videoPath(ctx.projectDir, ctx.tl, ratio, preset);
    const a = aspect(ratio);
    const body = fs.existsSync(file)
      ? `<video controls preload="metadata" playsinline src="${ctx.rel(file)}"></video>`
      : `<div class="placeholder"><p>動画がまだありません。</p><p class="muted">${esc(path.relative(ctx.projectDir, file).replace(/\\/g, '/'))} を書き出すと、ここで再生できます。</p></div>`;
    // 比率が複数なら、高さがそろうように幅を縦横比で分ける。.frame の高さの上限（72vh）は、
    // 高さがそろったどの枠にも同時にかかり、幅は縦横比のまま縮むので、低い窓でもそろったまま（ブラウザの試験で確かめている）
    return `<figure class="player"${a ? ` style="--ar:${a.w}/${a.h};flex:${a.w / a.h} 1 0"` : ''}><div class="frame">${body}</div>${ctx.tl.ratios.length > 1 ? `<figcaption>${esc(ratio)}</figcaption>` : ''}</figure>`;
  }).join('')}<p class="now" id="now" aria-live="polite"></p></div>`;
}

/** 全体へのコメント */
const overallSection = () => `<section class="card overall" aria-labelledby="overall-h"><h2 id="overall-h">全体へのコメント</h2>
${commentBox('overall', '全体への指摘や感想', '例：BGM をもう少し静かに')}</section>`;

// ---- 関門ごとの中身 ----

/**
 * ブリーフィングの要件のまとめ（briefing.md。初版の brief.md も読む）。届いていない素材と、仮に決めたことは目立つ枠で出す。
 * @param {Ctx} ctx
 */
function requirementsHtml(ctx) {
  const file = briefingFile(ctx.projectDir);
  const md = readText(file);
  const { rest: noMissing, missing } = md ? splitMissing(md) : { rest: '', missing: [] };
  const { rest, items: provisional } = splitSection(noMissing, (h) => h.includes('仮に決めた'));
  const missingHtml = missing.length
    ? `<section class="card missing" aria-labelledby="missing-h"><h2 id="missing-h">まだ届いていない素材</h2>
<p>次のものが届くまで、その部分は作れません。用意できたら、チャットで渡してください。</p><ul>${missing.map((m) => `<li>${inline(m)}</li>`).join('')}</ul></section>`
    : '';
  const provisionalHtml = provisional.length
    ? `<section class="card missing" aria-labelledby="prov-h"><h2 id="prov-h">仮に決めたこと</h2>
<p>聞かずに仮に決めたことです。違っていれば、チャットで伝えてください。</p><ul>${provisional.map((m) => `<li>${inline(m)}</li>`).join('')}</ul></section>`
    : '';
  return `${missingHtml}${provisionalHtml}
<section class="card doc" aria-labelledby="req-h"><h2 id="req-h">要件のまとめ</h2>
${md ? renderMarkdown(rest) : '<p class="muted">briefing.md がまだありません。</p>'}</section>`;
}

/** @param {Ctx} ctx */
function briefingContent(ctx) {
  const assets = receivedAssets(ctx.projectDir);
  const tiles = assets.map((file) => {
    const ext = path.extname(file).toLowerCase();
    const name = path.relative(path.join(ctx.projectDir, 'assets'), file).replace(/\\/g, '/');
    let media = `<div class="file-ext">${esc(ext.slice(1).toUpperCase() || 'FILE')}</div>`;
    if (IMAGE_EXT.has(ext)) media = `<img src="${ctx.rel(file)}" alt="${esc(name)}" loading="lazy">`;
    else if (AUDIO_EXT.has(ext)) media = `<div class="file-ext">音</div><audio controls preload="none" src="${ctx.rel(file)}"></audio>`;
    else if (VIDEO_EXT.has(ext)) media = `<video controls preload="metadata" src="${ctx.rel(file)}"></video>`;
    return `<li class="asset"><div class="asset-media">${media}</div><p class="asset-name">${esc(name)}</p><p class="muted">${fileSize(file)}</p></li>`;
  }).join('');
  return `${requirementsHtml(ctx)}
<section class="card" aria-labelledby="assets-h"><h2 id="assets-h">受け取った素材（${assets.length}件）</h2>
${assets.length ? `<ul class="assets">${tiles}</ul>` : '<p class="muted">まだ素材を受け取っていません。</p>'}</section>`;
}

/** @param {Ctx} ctx */
function styleContent(ctx) {
  // 案を選ぶのはスタイルの選択のページだけ（構成の確認や納品では、決めた見た目を見せるだけ）
  const choosing = ctx.gate === 'style';
  const dir = path.join(ctx.reviewsDir, 'style');
  const stills = listFiles(dir).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));
  // 名前の先頭（- か _ の前）が同じ静止画を 1 つの案にまとめる（a-1.png と a-2.png は案 A）
  const groups = new Map();
  for (const f of stills) {
    const key = path.basename(f, path.extname(f)).split(/[-_]/)[0].toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const options = [...groups].map(([key, files]) => `<article class="option">
<div class="option-media">${files.map((f) => `<img src="${ctx.rel(f)}" alt="案${esc(key)}の静止画" loading="lazy">`).join('')}</div>
${choosing ? `<label class="choose"><input type="radio" name="choice" value="${esc(key)}"> <span>案 ${esc(key)} にする</span></label>` : ''}</article>`).join('');
  const md = styleText(ctx);
  return `<section class="card" aria-labelledby="opt-h"><h2 id="opt-h">${choosing ? '見た目の案' : '見た目'}</h2>
${options ? `<div class="options">${options}</div>` : '<p class="muted">まだ案の静止画がありません。</p>'}</section>
<section class="card doc" aria-labelledby="style-h"><h2 id="style-h">色・書体・動きの説明</h2>
${md ? renderMarkdown(md) : '<p class="muted">style.md がまだありません。</p>'}</section>
${ctx.gate === 'style' ? intentSection(ctx) : ''}`;
}

/**
 * style.md の本文。「既定から外すこと」の節は、同じページの intentSection が一覧で出すので除く（2回出さない）。
 * @param {Ctx} ctx
 * @returns {string|null}
 */
function styleText(ctx) {
  const md = readText(path.join(ctx.projectDir, 'style.md'));
  return md === null ? null : splitSection(md, (h) => h.includes('既定から外す')).rest;
}

/** 構成の確認（サンプル）: ブリーフィング・スタイル・絵コンテを1枚に @param {Ctx} ctx */
function planContent(ctx) {
  return `${briefingContent(ctx)}
${styleContent(ctx)}
${storyboardContent(ctx)}
${intentSection(ctx)}`;
}

/** 点検の名前の、利用者向けの言い方 */
const CHECK_NAMES = {
  flash: '点滅', contrast: '文字のコントラスト', overflow: '文字のはみ出し', 'safe-area': '字幕の安全域', overlap: '文字どうしの重なり',
  cover: '文字の上に重なる形', blank: 'つなぎ目の一瞬の空白', hold: '文字を読める時間', narration: 'ナレーションの重なり',
  loudness: '音量', loop: 'ループの継ぎ目',
};

/**
 * 冒頭の注意書きを入れたか。style.md の「点滅の注意書き: 入れる／入れない」の行から読む（無ければ未確認）
 * @param {Ctx} ctx
 */
function flashNotice(ctx) {
  const m = (readText(path.join(ctx.projectDir, 'style.md')) ?? '').match(/点滅の注意書き\s*[:：]\s*(入れない|入れる)/);
  if (!m) return '冒頭の注意書きを入れたかは、まだ確かめていません。';
  return m[1] === '入れる' ? '冒頭に注意書きを入れています。' : '冒頭に注意書きは入れていません（使う人が決めました）。';
}

/** 意図の宣言（settings.intent と、シーンで見た data-ms-intent） */
function declaredIntents(ctx) {
  return { intents: ctx.project?.settings?.intent ?? [], seen: readIntentSeen(ctx.projectDir) };
}

/**
 * この動画で既定から外していること（style.md の「既定から外すこと」節、settings.intent、シーンの data-ms-intent）。何も無ければ出さない。
 * settings.intent は、スタイルの確認（無ければ構成の確認）の承認より後に足したものに「後から足した」を付ける（お試しは基準が無いので付けない）。
 * シーンの data-ms-intent は、シーンを描くのが承認の後なので、最初の点検で見つけたものには付けず、その後の点検で増えたものにだけ付ける。
 * @param {Ctx} ctx
 */
function intentSection(ctx) {
  const style = readText(path.join(ctx.projectDir, 'style.md'));
  const { items: written } = style ? splitSection(style, (h) => h.includes('既定から外す')) : { items: [] };
  const { intents, seen } = declaredIntents(ctx);
  if (!written.length && !intents.length && !seen.length) return '';
  const base = ctx.project?.gates?.style?.approvedAt ?? ctx.project?.gates?.plan?.approvedAt ?? null;
  const pill = '<span class="pill wait">後から足した</span>';
  const late = (at) => (base && at && at > base ? pill : '');
  const firstCheck = seen.reduce((m, x) => (!m || x.firstSeenAt < m ? x.firstSeenAt : m), null);
  const lateSeen = (at) => (base && firstCheck && at > firstCheck ? pill : '');
  const name = (c) => CHECK_NAMES[c] ?? c;
  const cutOfScene = (id) => {
    const i = ctx.tl?.scenes?.findIndex((s) => s.id === id) ?? -1;
    return i >= 0 ? `カット${i + 1}（${id}）` : id;
  };
  const declared = intents.map((x) => `<li>${late(x.addedAt)}<strong>${esc(name(x.check))}</strong>　${esc(x.why)}${
    x.scenes?.length ? `<span class="muted">（${esc(x.scenes.map(cutOfScene).join('、'))}）</span>` : '<span class="muted">（動画全体）</span>'}</li>`).join('');
  const byScene = seen.map((x) => `<li>${lateSeen(x.firstSeenAt)}${esc(cutOfScene(x.scene))}: <strong>${esc(name(x.check))}</strong><span class="muted">（シーンの要素で宣言${x.count ? `。要素 ${x.count} 個` : ''}）</span></li>`).join('');
  return `<section class="card doc" aria-labelledby="intent-h"><h2 id="intent-h">この動画で既定から外していること</h2>
<p class="muted">何も言われなければ避けることのうち、この動画では演出の意図があって使っているものです。自動点検は、これに当たる指摘を「意図どおり」として数えません。</p>
${written.length ? `<h3>スタイルで決めたこと</h3><ul>${written.map((m) => `<li>${inline(m)}</li>`).join('')}</ul>` : ''}
${declared ? `<h3>点検での扱い</h3><ul>${declared}</ul>` : ''}
${byScene ? `<h3>シーンの中で外した箇所</h3><ul>${byScene}</ul>` : ''}</section>`;
}

/**
 * storyboard.md を、カットの節（「## カット3（…）」）ごとに分ける。
 * @param {string} md
 * @returns {{head: string, cuts: Map<number, string>, tail: string}} head は最初のカットの節より前（題の行を除く）、cuts はカット番号 → 節の本文、
 *   tail はカットの節のあとに続く、カットでない節（補足・音・確認事項など）
 */
export function splitStoryboard(md) {
  const head = [];
  const cuts = new Map();
  const tail = [];
  let cur = null;
  let afterCuts = false;
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const h = line.match(/^#{2,3}\s*カット\s*([0-9０-９]+)/);
    if (h) {
      cur = Number(h[1].replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)));
      cuts.set(cur, []);
      afterCuts = false;
      continue;
    }
    // カットのあとに別の ## の節が来たら、そこでカットを終える（最後のカットに巻き込まない）
    if (cur !== null && /^##\s/.test(line)) { cur = null; afterCuts = true; }
    if (afterCuts) tail.push(line);
    else if (cur === null) {
      if (!/^#\s/.test(line)) head.push(line);
    } else cuts.get(cur).push(line);
  }
  return { head: head.join('\n').trim(), cuts: new Map([...cuts].map(([k, v]) => [k, v.join('\n').trim()])), tail: tail.join('\n').trim() };
}

/** @param {Ctx} ctx */
function storyboardContent(ctx) {
  const md = readText(path.join(ctx.projectDir, 'storyboard.md'));
  const board = md ? splitStoryboard(md) : null;
  return `${board?.head ? `<section class="card doc" aria-labelledby="board-h"><h2 id="board-h">絵コンテの前提</h2>${renderMarkdown(board.head)}</section>` : ''}
<section aria-labelledby="cuts-h"><h2 id="cuts-h" class="section-h">カットごとの流れ（${ctx.tl.scenes.length}カット）</h2>
<div class="cuts wide">${cutList(ctx, { jump: false, board: board?.cuts })}</div></section>
${board?.tail ? `<section class="card doc" aria-labelledby="tail-h"><h2 id="tail-h">カット以外の補足</h2>${renderMarkdown(board.tail)}</section>` : ''}`;
}

/** @param {Ctx} ctx */
function roughContent(ctx) {
  // コンタクトシートは長い動画では何枚かに分かれる（contact-<比率>-01.png, -02.png …）
  const names = fs.existsSync(ctx.reviewsDir) ? fs.readdirSync(ctx.reviewsDir).sort() : [];
  const sheets = ctx.tl.ratios.flatMap((r) => names
    .filter((n) => n.startsWith(`contact-${ratioDir(r)}-`) && /^\d+\.png$/.test(n.slice(`contact-${ratioDir(r)}-`.length)))
    .map((n) => path.join(ctx.reviewsDir, n)));
  return `<div class="stage">
<div class="stage-media">${players(ctx, 'draft')}</div>
<section class="stage-cuts" aria-labelledby="cuts-h"><h2 id="cuts-h" class="section-h">カットごとの確認（${ctx.tl.scenes.length}カット）</h2>
<div class="cuts">${cutList(ctx, { jump: true, stage: 'build' })}</div></section>
</div>
${compromisesSection(ctx, { always: false })}
${sheets.length ? `<section class="card" aria-labelledby="sheet-h"><h2 id="sheet-h">コンタクトシート</h2>
<p class="muted">1秒ごとの静止画を並べたものです。流れ全体を一度に見渡せます（長い動画は、32 コマごとに分けて並べています）。</p>
${sheets.map((f) => `<img class="sheet" src="${ctx.rel(f)}" alt="コンタクトシート" loading="lazy">`).join('')}</section>` : ''}`;
}

/** 節の見出しと同じ「# 見出し」が Markdown の先頭にあれば外す（ページの節の見出しと二重に出さないため） */
function dropTitle(md, title) {
  return md.replace(/^﻿?\s*#[ \t]+([^\r\n]+?)[ \t]*(?:\r?\n|$)/, (m, h) => (h.trim() === title ? '' : m));
}

/** models の VOICEVOX の記録から名前とスタイルを取る。character と style があればそれを、古い記録は voice の最後の「/」で分ける */
function voicevoxWho(m) {
  if (m.character) return { name: String(m.character), style: m.style ? String(m.style) : '' };
  const v = String(m.voice ?? '');
  const i = v.lastIndexOf('/');
  return i < 0 ? { name: v, style: '' } : { name: v.slice(0, i), style: v.slice(i + 1) };
}

/** 権利の一覧。reviews/rights.md があればそれを、無ければ記録から組む */
function rightsHtml(ctx) {
  const md = readText(path.join(ctx.reviewsDir, 'rights.md'));
  if (md) return renderMarkdown(dropTitle(md, '使った素材と権利'));
  const rows = [];
  const models = ctx.project?.models ?? [];
  // VOICEVOX の表記は声の行にまとめて出すので、クレジット表記の行では重ねない
  const voiceNames = new Set(models.filter((m) => m.model === 'voicevox').map((m) => voicevoxWho(m).name));
  for (const c of ctx.project?.credits ?? []) {
    if (c.startsWith('VOICEVOX:') && voiceNames.has(c.slice('VOICEVOX:'.length))) continue;
    rows.push(['クレジット表記', esc(c), '']);
  }
  for (const m of models) {
    if (m.model === 'voicevox') {
      // VOICEVOX はパソコンの中の読み上げ。表記はキャラクター名だけで、条件はキャラクターごとの規約による
      const { name, style } = voicevoxWho(m);
      // 規約の場所と確かめた日は記録から。古い記録は、使ってよいキャラクターの一覧から引く（ページは外を参照しないので、URL は文字で出す）
      const known = characterTerms(name);
      const terms = m.terms ?? known?.terms;
      const checked = m.termsChecked ?? known?.checked;
      const termsText = terms
        ? `条件はキャラクターの利用規約（${esc(terms)}${checked ? `、${esc(checked)} に確認` : ''}）に従う${known ? `: ${esc(known.note)}` : ''}`
        : '条件はキャラクターの利用規約に従う';
      rows.push(['ナレーションの声（VOICEVOX）', `VOICEVOX:${esc(name)}${style ? `（${esc(style)}）` : ''}`,
        `話す速さ ${esc(m.speed ?? 1)}、抑揚 ${esc(m.intonation ?? 1)}。動画の説明欄などに「VOICEVOX:${esc(name)}」と表記する。${termsText}${m.date ? `（${esc(m.date)}）` : ''}`]);
      continue;
    }
    rows.push([m.kind === 'music' ? 'BGM（生成）' : 'ナレーションの声（生成）', esc(m.model), esc(m.date ?? '')]);
  }
  const bgm = ctx.tl.bgm;
  if (bgm) rows.push(['BGM', esc(bgm.file ?? ''), esc([bgm.source, bgm.license].filter(Boolean).join('／'))]);
  for (const f of fontFamilies(ctx.projectDir)) {
    rows.push(['書体', esc(f.name), f.source ? `${esc(f.source)}（assets/fonts/）` : '出どころの記録なし（assets/fonts/）。入手元とライセンスを確かめてください']);
  }
  for (const f of receivedAssets(ctx.projectDir)) {
    rows.push(['受け取った素材', esc(path.relative(path.join(ctx.projectDir, 'assets'), f).replace(/\\/g, '/')), 'ご提供のもの']);
  }
  if (!rows.length) return '<p class="muted">記録がありません。</p>';
  return `<div class="table"><table><thead><tr><th>種類</th><th>素材</th><th>出どころ・条件</th></tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** @param {Ctx} ctx */
function deliverContent(ctx) {
  const files = [];
  for (const r of ctx.tl.ratios) {
    const mp4 = videoPath(ctx.projectDir, ctx.tl, r, 'final');
    files.push(mp4, mp4.replace(/\.mp4$/, '_poster.png'), mp4.replace(/\.mp4$/, '_loop.mp4'));
  }
  const present = files.filter((f) => fs.existsSync(f));
  const posters = present.filter((f) => f.endsWith('_poster.png'));
  const course = ctx.project?.settings?.course ?? 'full';
  const { intents, seen } = declaredIntents(ctx);
  // 宣言しただけでなく、--waive で例外にした点滅も、動画に点滅が残っているので注意を出す
  const flash = intents.some((x) => x.check === 'flash') || seen.some((x) => x.check === 'flash') || readWaivers(ctx.projectDir).some((w) => w.check === 'flash');
  const flashHtml = flash
    ? `<section class="card missing" aria-labelledby="flash-h"><h2 id="flash-h">点滅についての注意</h2>
<p>この動画には点滅があります。光に敏感な人が発作を起こすおそれがあります。SNS や展示会など不特定の人が見る場所では、冒頭に注意書きを入れることを検討してください。</p>
<p><strong>${esc(flashNotice(ctx))}</strong></p></section>`
    : '';
  // 省いたコースでは、ほかの確認ページで見ていないことを、ここでまとめて見せる
  const board = readText(path.join(ctx.projectDir, 'storyboard.md'));
  const style = styleText(ctx);
  const decided = course === 'full' ? '' : `${requirementsHtml(ctx)}
${style ? `<section class="card doc" aria-labelledby="style-h"><h2 id="style-h">色・書体・動きの説明</h2>${renderMarkdown(style)}</section>` : ''}
${course === 'trial' && board ? `<section class="card doc" aria-labelledby="board-h"><h2 id="board-h">カットごとの流れ（絵コンテ）</h2>${renderMarkdown(dropTitle(board, '絵コンテ'))}</section>` : ''}`;
  const upgrade = course === 'full' ? '' : `<section class="card" aria-labelledby="up-h"><h2 id="up-h">本番の工程で作り込む</h2>
<p>この動画を本番用に仕上げたいときは、チャットで「本番用に仕上げたい」と伝えてください。省いた確認を順に行い、作ったものはそのまま引き継ぎます。</p></section>`;
  return `${flashHtml}<div class="stage">
<div class="stage-media">${players(ctx, 'final')}</div>
<section class="stage-cuts" aria-labelledby="cuts-h"><h2 id="cuts-h" class="section-h">カットごとの確認（${ctx.tl.scenes.length}カット）</h2>
<div class="cuts">${cutList(ctx, { jump: true, stage: 'final' })}</div></section>
</div>
<section class="card" aria-labelledby="files-h"><h2 id="files-h">納品するファイル</h2>
${present.length ? `<ul class="files">${present.map((f) => `<li><a href="${ctx.rel(f)}">${esc(path.basename(f))}</a><span class="muted">${fileSize(f)}</span></li>`).join('')}</ul>` : '<p class="muted">まだ書き出していません。</p>'}
${posters.length ? `<h3>ポスター画像</h3><div class="posters">${posters.map((f) => `<img src="${ctx.rel(f)}" alt="ポスター画像" loading="lazy">`).join('')}</div>` : ''}</section>
<section class="card doc" aria-labelledby="rights-h"><h2 id="rights-h">使った素材と権利</h2>${rightsHtml(ctx)}</section>
${decided}
${intentSection(ctx)}
${compromisesSection(ctx, { always: true })}
${upgrade}`;
}

/**
 * 残った妥協点（reviews/compromises.md）と、点検で例外にしたもの（reviews/waivers.json）を1つの欄に出す。
 * 例外は理由と並べ、いまの点検の結果（build と final）で例外として当たっていなければ、そのことを添える。
 * @param {Ctx} ctx
 * @param {{always: boolean}} opts always が false なら、どちらも無いときは欄を出さない
 */
function compromisesSection(ctx, { always }) {
  const md = readText(path.join(ctx.reviewsDir, 'compromises.md'));
  const waivers = readWaivers(ctx.projectDir);
  if (!md && !waivers.length && !always) return '';
  const current = ['build', 'final'].flatMap((stage) => ctx.tl.ratios.flatMap((r) => checkFindings(ctx.projectDir, stage, r))).filter((f) => f.waived);
  const multi = ctx.tl.ratios.length > 1;
  const items = waivers.map((w) => `<li><p>${multi && w.ratio ? `${esc(w.ratio)}: ` : ''}${esc(w.message)}</p><p class="muted">理由: ${esc(w.why)}${
    current.some((f) => waiverMatches(w, f)) ? '' : '（いまの点検では出ていません。直したか、中身が変わったため）'}</p></li>`).join('');
  const waived = waivers.length
    ? `<h3>点検で例外にしたもの</h3><p class="muted">自動点検の指摘のうち、画像で確かめて問題ではないと判断し、数えないことにしたものです。</p><ul class="waivers">${items}</ul>`
    : '';
  const body = md ? renderMarkdown(dropTitle(md, '残った妥協点')) : waivers.length ? '' : '<p class="muted">ありません。</p>';
  return `<section class="card doc" aria-labelledby="comp-h"><h2 id="comp-h">残った妥協点</h2>
${body}${waived}</section>`;
}

const CONTENT = { briefing: briefingContent, style: styleContent, storyboard: storyboardContent, plan: planContent, rough: roughContent, deliver: deliverContent };

// ---- 見た目と動き ----

const CSS = `
:root{color-scheme:light dark;--bg:#f5f5f3;--surface:#fff;--surface-2:#efefec;--text:#1d1d1f;--muted:#5c5f63;--line:#dcdcd6;
--accent:#2d5b87;--accent-text:#fff;--accent-soft:#e6eef6;--warn-bg:#fdf3e1;--warn-line:#d9a24a;--warn-text:#6e4600;
--ok:#2b7149;--ok-bg:#e5f2ea;--wait:#7a5a00;--wait-bg:#f7ecd0;--video:#0e0e0f;--shadow:0 1px 2px rgba(0,0,0,.05)}
@media (prefers-color-scheme: dark){:root{--bg:#141415;--surface:#1d1d1f;--surface-2:#26262a;--text:#ececec;--muted:#a6a6ab;--line:#35353a;
--accent:#93b6dc;--accent-text:#0f1720;--accent-soft:#22303e;--warn-bg:#33291a;--warn-line:#a87b30;--warn-text:#f1d39f;
--ok:#86c9a0;--ok-bg:#1f3428;--wait:#e8c977;--wait-bg:#3a3120;--video:#000;--shadow:none}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.7 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Meiryo","Noto Sans JP",sans-serif;padding-bottom:96px}
.wrap{max-width:1240px;margin:0 auto;padding:0 16px}
@media (min-width:720px){.wrap{padding:0 32px}}
header.top{padding:32px 0 20px}
.eyebrow{margin:0;color:var(--muted);font-size:14px;letter-spacing:.04em}
h1{margin:4px 0 8px;font-size:clamp(24px,3vw,32px);line-height:1.3;font-weight:700}
.lead{margin:0;max-width:52em}
.howto{margin:6px 0 0;max-width:52em;color:var(--muted);font-size:14px}
h2{font-size:19px;line-height:1.4;margin:0 0 12px}
h3{font-size:16px;margin:20px 0 8px}
.section-h{margin:4px 0 12px}
.muted{color:var(--muted)}
main{display:grid;gap:24px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px;box-shadow:var(--shadow)}
@media (min-width:720px){.card{padding:24px 28px}}
.prev summary{cursor:pointer;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px}
.prev summary h2{margin:0;display:inline}
.prev summary .muted{font-size:14px}
.prev[open] summary{margin-bottom:12px}
.prev-list{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.prev-list li{border-top:1px solid var(--line);padding-top:12px}
.prev-list p{margin:0}
.said{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}
.where{font-weight:700}
.gate{color:var(--muted);font-size:13px}
.how{margin-top:4px!important;color:var(--muted);font-size:14px}
.pill{display:inline-block;font-size:12px;font-weight:700;border-radius:999px;padding:1px 10px;margin-right:8px}
.pill.ok{background:var(--ok-bg);color:var(--ok)}
.pill.wait{background:var(--wait-bg);color:var(--wait)}
.missing{background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn-text)}
.missing ul{margin:8px 0 0;padding-left:1.4em;font-weight:700}
.doc>:last-child{margin-bottom:0}
.doc p,.doc ul,.doc ol{max-width:52em}
code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:.92em;background:var(--surface-2);border-radius:4px;padding:1px 5px}
pre{background:var(--surface-2);border-radius:8px;padding:12px;overflow:auto}
.sw{display:inline-block;width:.9em;height:.9em;border-radius:3px;border:1px solid var(--line);vertical-align:-.1em;margin-right:4px}
.table{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:15px}
th,td{text-align:left;border-bottom:1px solid var(--line);padding:8px 10px;vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:13px}
.assets{list-style:none;margin:0;padding:0;display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}
.asset-media{aspect-ratio:4/3;background:repeating-conic-gradient(#8a8f98 0% 25%,#a3a8b0 0% 50%) 50%/16px 16px;border-radius:8px;display:grid;place-items:center;overflow:hidden;gap:6px;padding:6px}
.asset-media img,.asset-media video{width:100%;height:100%;object-fit:contain}
.asset-media audio{width:100%}
.file-ext{font-weight:700;color:var(--muted);letter-spacing:.06em}
.asset-name{margin:8px 0 0;font-size:14px;word-break:break-all}
.asset p.muted{margin:0;font-size:13px}
.options{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))}
.option{border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;gap:12px}
.option:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 2px var(--accent)}
.option-media{display:grid;gap:8px}
.option-media img{width:100%;border-radius:6px;display:block;background:var(--surface-2)}
.choose{display:flex;gap:8px;align-items:center;font-weight:700;cursor:pointer}
.choose input{width:18px;height:18px;accent-color:var(--accent)}
.stage{display:grid;gap:24px}
@media (min-width:1080px){.stage{grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);align-items:start}
.stage-media{position:sticky;top:16px}}
.players{display:grid;gap:16px}
.players.multi{display:flex;flex-wrap:wrap;align-items:flex-start}
.players.multi .now{flex-basis:100%}
.players.multi .player{min-width:0}
.player{margin:0}
.frame{background:var(--video);border-radius:10px;overflow:hidden;aspect-ratio:var(--ar);max-height:72vh;margin:0 auto;display:grid}
.frame video{width:100%;height:100%;display:block;background:var(--video)}
.placeholder{display:grid;place-content:center;text-align:center;padding:16px;color:#e6e6e6}
.placeholder p{margin:0}
.placeholder .muted{color:#a9a9ad;font-size:14px}
.player figcaption{color:var(--muted);font-size:13px;margin-top:6px;text-align:center}
.now:empty{display:none}
.now{margin:0;color:var(--muted);font-size:14px;text-align:center}
.cuts{display:grid;gap:12px}
.cut{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px;scroll-margin-top:16px;transition:border-color .2s}
.cut.is-now{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.cut-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin-bottom:10px}
.jump{display:inline-flex;align-items:baseline;gap:10px;font:inherit;color:inherit;background:none;border:0;padding:4px 8px;margin:-4px -8px;border-radius:8px}
button.jump{cursor:pointer}
button.jump:hover{background:var(--accent-soft)}
button.jump:focus-visible,button:focus-visible,textarea:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.no{font-weight:700;font-size:17px}
.time{color:var(--muted);font-variant-numeric:tabular-nums;font-size:14px}
.len{margin-left:2px}
.play{color:var(--accent);font-size:12px}
.purpose{margin:0;color:var(--muted);font-size:14px}
.cut-body{display:grid;gap:12px}
.cuts.wide .cut-body{grid-template-columns:minmax(0,1fr)}
@media (min-width:860px){.cuts.wide .cut-body{grid-template-columns:260px minmax(0,1fr) minmax(0,1fr);align-items:start}}
@media (min-width:860px){.cuts.wide .cut-body:has(.thumbs){grid-template-columns:420px minmax(0,1fr) minmax(0,1fr)}}
.words .board{margin-top:10px;font-size:14px;line-height:1.7}
.words .board ul{margin:0;padding-left:1.2em}
.words dl+dl{margin-top:8px}
.thumb{margin:0;border-radius:8px;overflow:hidden;background:var(--surface-2)}
.thumb img{display:block;width:100%}
.thumbs{display:flex;gap:8px;align-items:flex-start}
.thumbs .thumb{min-width:0}
.thumb figcaption{font-size:12px;color:var(--muted);padding:2px 6px}
.thumb.empty{aspect-ratio:16/9;display:grid;place-items:center;color:var(--muted);font-size:13px}
.stage-cuts .thumb{max-width:320px}
dl{margin:0;display:grid;gap:2px}
dt{font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.04em;margin-top:6px}
dt:first-child{margin-top:0}
dd{margin:0;display:flex;flex-wrap:wrap;gap:0 10px;align-items:baseline}
.say{font-size:16px;white-space:pre-line}
.at{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
.tag{color:var(--muted);font-size:12px;border:1px solid var(--line);border-radius:999px;padding:0 8px;font-variant-numeric:tabular-nums}
.notes{margin-top:10px;background:var(--warn-bg);border-radius:8px;padding:8px 12px;color:var(--warn-text);font-size:14px}
.notes p{margin:0;font-weight:700;font-size:13px}
.notes ul{margin:4px 0 0;padding-left:1.2em}
.notes.meant{background:var(--ok-bg);color:var(--ok)}
.waivers li p{margin:0}
.waivers li+li{margin-top:8px}
.comment{display:grid;gap:4px}
.comment label{font-size:13px;color:var(--muted);font-weight:600}
textarea{width:100%;font:inherit;font-size:15px;line-height:1.6;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;resize:vertical;min-height:4.6em}
textarea:focus{border-color:var(--accent)}
.sheet{width:100%;display:block;border-radius:8px;background:var(--surface-2)}
.files{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.files li{display:flex;gap:12px;flex-wrap:wrap;align-items:baseline}
.files a{color:var(--accent);word-break:break-all}
.posters{display:flex;gap:12px;flex-wrap:wrap}
.posters img{max-width:min(100%,360px);max-height:360px;border-radius:8px;border:1px solid var(--line)}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--surface);border-top:1px solid var(--line);z-index:5}
.bar-in{display:flex;align-items:center;gap:8px 16px;padding-top:12px;padding-bottom:12px;flex-wrap:wrap}
.bar-info{flex:1 1 200px;min-width:0;font-size:14px;color:var(--muted)}
#status{color:var(--text)}
#status.ok::before{content:"✓ ";color:var(--ok);font-weight:700}
.bar button{font:inherit;font-size:15px;border-radius:8px;padding:9px 18px;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--text)}
.bar button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text);font-weight:700}
.bar button.primary:hover{filter:brightness(1.08)}
#manual{padding-bottom:12px}
#manual p{margin:0 0 6px;font-size:14px}
@media (max-width:520px){.bar button.quiet{display:none}.bar-in{flex-wrap:nowrap}.bar-info{flex:1 1 0;font-size:13px;line-height:1.5}
.bar button.primary{padding:9px 14px;white-space:nowrap}body{padding-bottom:120px}}
@media (prefers-reduced-motion: reduce){*{transition:none!important;scroll-behavior:auto!important}}
`;

/**
 * ページの動き。CFG はページに埋める設定（key、title、gate、cuts）。
 * ブラウザの一時保存（localStorage）は、使えない環境でも止まらないよう、触るたびに try で包む。
 */
const SCRIPT = `
const fields = Array.from(document.querySelectorAll('textarea[data-key]'));
const choices = Array.from(document.querySelectorAll('input[name="choice"]'));
const videos = Array.from(document.querySelectorAll('.player video'));
const cards = Array.from(document.querySelectorAll('article.cut'));
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const manual = document.getElementById('manual');
let timer = 0;

function say(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? 'ok' : '';
  clearTimeout(timer);
  if (ok) timer = setTimeout(function () { statusEl.textContent = ''; statusEl.className = ''; }, 4000);
}

function collect() {
  const state = {};
  fields.forEach(function (f) { if (f.value.trim()) state[f.dataset.key] = f.value; });
  const picked = choices.find(function (c) { return c.checked; });
  if (picked) state.choice = picked.value;
  return state;
}

function items(state) {
  const out = [];
  CFG.cuts.forEach(function (c) {
    const text = state[String(c.cut)];
    if (text && text.trim()) out.push({ cut: c.cut, start: c.start, end: c.end, text: text });
  });
  if (state.choice) out.push({ cut: null, text: '選んだ案：' + state.choice });
  if (state.overall && state.overall.trim()) out.push({ cut: null, text: state.overall });
  return out;
}

function updateCount() {
  const n = items(collect()).length;
  countEl.textContent = n ? '指摘 ' + n + '件' : 'まだ何も書かれていません';
}

// 保存の形: { state: 欄の中身, sent: コピーしたときの中身, sentBuild: そのときのページの版 }
let sent = null;
let sentBuild = null;

function store() {
  const data = JSON.stringify({ state: collect(), sent: sent, sentBuild: sentBuild });
  try { localStorage.setItem(CFG.key, data); return true; } catch (e) { return false; }
}

function save() {
  const ok = store();
  updateCount();
  if (ok) say('保存しました', true);
  else say('このブラウザでは一時保存ができません。ページを閉じる前にコピーしてください。', false);
}

let raw = null;
try { raw = localStorage.getItem(CFG.key); } catch (e) { raw = null; }
let stored = {};
if (raw) { try { stored = JSON.parse(raw) || {}; } catch (e) { stored = {}; } }
// 前の形（欄の中身だけ）で残っていれば、そのまま書きかけとして戻す
let saved = (stored.state !== undefined ? stored.state : stored) || {};
let dropped = false;
if (stored.sent && stored.sentBuild && stored.sentBuild !== CFG.build) {
  // 作り直したページでは、コピー済みの指摘を欄に戻さない（同じ指摘を二度送らないため）。コピーの後に書いた分は戻す
  const keep = {};
  Object.keys(saved).forEach(function (k) { if (stored.sent[k] === saved[k]) dropped = true; else keep[k] = saved[k]; });
  saved = keep;
} else if (stored.sent) {
  sent = stored.sent;
  sentBuild = stored.sentBuild;
}
fields.forEach(function (f) {
  if (typeof saved[f.dataset.key] === 'string') f.value = saved[f.dataset.key];
  f.addEventListener('input', save);
});
choices.forEach(function (c) {
  c.checked = saved.choice === c.value;
  c.addEventListener('change', save);
});
updateCount();
if (dropped) { store(); say('前回コピーした指摘は欄から外しました。対応は「前回の指摘と対応」で見られます', false); }
else if (items(saved).length) say('前に書いた内容を戻しました', false);

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

document.getElementById('copy').addEventListener('click', async function () {
  const list = items(collect());
  if (!list.length) { say('まだ何も書かれていません。気になるところを欄に書いてから押してください。', false); return; }
  const text = copyText(CFG.title, CFG.gate, list);
  // コピーした中身と版を覚える（作り直したページでは欄に戻さない）。クリップボードを待つ前に残す
  sent = collect();
  sentBuild = CFG.build;
  store();
  let ok = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = false; }
  }
  if (!ok) ok = legacyCopy(text);
  if (ok) {
    manual.hidden = true;
    say('コピーしました。チャットに貼り付けてください。', true);
  } else {
    manual.hidden = false;
    const box = manual.querySelector('textarea');
    box.value = text;
    box.focus();
    box.select();
    say('自動でコピーできませんでした。下の文を選んでコピーしてください。', false);
  }
});

document.getElementById('clear').addEventListener('click', function () {
  if (!confirm('このページに書いた内容をすべて消します。よろしいですか？')) return;
  fields.forEach(function (f) { f.value = ''; });
  choices.forEach(function (c) { c.checked = false; });
  sent = null;
  sentBuild = null;
  try { localStorage.removeItem(CFG.key); } catch (e) { /* 保存できない環境では消すものもない */ }
  updateCount();
  say('消しました', true);
});

document.addEventListener('click', function (e) {
  const btn = e.target.closest('[data-jump]');
  if (!btn || !videos.length) return;
  const t = Number(btn.dataset.jump);
  videos.forEach(function (v, i) {
    const go = function () { v.currentTime = t; if (i === 0) { const p = v.play(); if (p && p.catch) p.catch(function () {}); } };
    if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
  });
  const r = videos[0].getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight) videos[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
});

if (videos.length) {
  const nowEl = document.getElementById('now');
  const mark = function () {
    const t = videos[0].currentTime;
    let idx = CFG.cuts.findIndex(function (c) { return t >= c.start && t < c.end; });
    if (idx < 0) idx = CFG.cuts.length - 1;
    cards.forEach(function (card, i) { card.classList.toggle('is-now', i === idx); });
    nowEl.textContent = '再生中：カット ' + CFG.cuts[idx].cut + '（' + formatClock(t) + '）';
  };
  // 再生しなくても、移動しただけで今のカットを示す
  videos[0].addEventListener('timeupdate', mark);
  videos[0].addEventListener('seeked', mark);
}
`;

/**
 * 関門の確認ページを作り、reviews/<関門>.html に書く。
 * @param {string} projectDir
 * @param {Gate} gate
 * @returns {string} 書いたファイルのパス
 */
export function buildReviewPage(projectDir, gate) {
  gate = /** @type {Gate} */ (normalizeName(gate));
  if (!(gate in GATE_LABELS)) throw new Error(`知らない関門です: ${gate}（${Object.keys(GATE_LABELS).join('、')} のいずれか）`);
  const reviewsDir = path.join(projectDir, 'reviews');
  let tl = null;
  try {
    tl = readTimeline(projectDir);
  } catch (e) {
    if (gate !== 'briefing') throw e; // ブリーフィングの段階では timeline.json がまだ無くてよい
  }
  let project = null;
  try {
    project = readProject(projectDir);
  } catch {
    project = null;
  }
  const title = project?.title || tl?.title || path.basename(path.resolve(projectDir));
  /** @type {Ctx} */
  const ctx = {
    projectDir, reviewsDir, gate, title, tl, project,
    rel: (file) => path.relative(reviewsDir, file).split(path.sep).map(encodeURIComponent).join('/'),
  };
  const cfg = {
    // 一時保存の鍵は制作フォルダごと（file:// のページはどれも同じ保存場所を使うため、同じ題名の別の動画と混ざらないように）
    key: `ns-motion-studio:${path.resolve(projectDir)}:${gate}`,
    // ページの版。作り直すたびに変わる（コピー済みの指摘を、作り直したページの欄に戻さないため）
    build: `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    title,
    gate,
    cuts: tl && gate !== 'briefing' && gate !== 'style' ? tl.scenes.map((s, i) => ({ cut: i + 1, start: s.start, end: s.end })) : [],
  };
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}　${esc(GATE_LABELS[gate])}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap">
<p class="eyebrow">${esc(GATE_LABELS[gate])}</p>
<h1>${esc(title)}</h1>
<p class="lead">${esc(LEADS[gate])}</p>
<p class="howto">${esc(HOWTO)}</p>
</div></header>
<main class="wrap">
${previousSection(ctx)}
${CONTENT[gate](ctx)}
${overallSection()}
</main>
<div class="bar" role="region" aria-label="指摘のまとめ"><div class="wrap">
<div id="manual" hidden><p>次の文を選んでコピーし、チャットに貼り付けてください。</p><textarea readonly rows="4" aria-label="コピーする文"></textarea></div>
<div class="bar-in">
<p class="bar-info"><span id="count"></span>　<span id="status" role="status" aria-live="polite"></span></p>
<button type="button" id="clear" class="quiet">書いた内容を消す</button>
<button type="button" id="copy" class="primary">指摘をまとめてコピー</button>
</div></div></div>
<script>
'use strict';
const CFG = ${json};
${formatClock.toString()}
${copyText.toString()}
${SCRIPT}
</script>
</body>
</html>
`;
  fs.mkdirSync(reviewsDir, { recursive: true });
  const file = path.join(reviewsDir, `${gate}.html`);
  fs.writeFileSync(`${file}.partial`, html);
  replaceFile(`${file}.partial`, file);
  return file;
}

/**
 * ファイルを既定のアプリで開くコマンド。Windows は explorer.exe にパスを1つの引数で渡す
 * （cmd /c start は引用符の中でも %名前% を展開するので、シェルを通さない）。macOS は open、それ以外は xdg-open。
 * @param {string} abs
 * @param {NodeJS.Platform} [platform]
 * @returns {[string, string[], object]}
 */
export function openArgs(abs, platform = process.platform) {
  // パスは引用符で囲んで1つの引数にする（空白が無くカンマがあるパスを、explorer が区切りとして読まないように）。Windows のパスに " は入らない
  if (platform === 'win32') return ['explorer.exe', [`"${abs}"`], { windowsVerbatimArguments: true }];
  return platform === 'darwin' ? ['open', [abs], {}] : ['xdg-open', [abs], {}];
}

/**
 * 既定のブラウザでファイルを開く。Windows は cmd /c start ""、macOS は open、それ以外は xdg-open。
 * シェルの文字列は組まず、引数で渡す（Windows は start の引用符をそのまま渡すため verbatim にする）。
 * @param {string} file
 */
export function openInBrowser(file) {
  const abs = path.resolve(file);
  const [cmd, args, extra] = openArgs(abs);
  const child = spawn(cmd, args, { ...extra, detached: true, stdio: 'ignore' });
  child.on('error', () => console.error(`ブラウザを開けませんでした。次のファイルを開いてください: ${abs}`));
  child.unref();
}

/**
 * 作ったページを見せる。初めて作ったページだけブラウザで開き、作り直したときは開いているタブの再読み込みを頼む
 * （作り直すたびに開くと、利用者のブラウザにタブが増え続けるため）。
 * @param {string} file
 * @param {boolean} existed 作る前からページがあったか
 * @param {{open?: (file: string) => void, log?: (line: string) => void}} [opts]
 */
export function showPage(file, existed, { open = openInBrowser, log = console.log } = {}) {
  if (existed) {
    log(`ページを作り直しました。開いているページを再読み込みしてください（閉じていれば、次のファイルを開いてください）: ${file}`);
    return;
  }
  log(file);
  open(file);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  // --no-open は試験と試走のためのもの（スキルの手順では使わない）
  const noOpen = args.includes('--no-open');
  const [projectDir, given] = args.filter((a) => !a.startsWith('--'));
  const gate = given && normalizeName(given);
  if (!projectDir || !gate) {
    console.error(`使い方: node review-page.mjs <制作フォルダ> ${Object.keys(GATE_LABELS).join('|')}`);
    process.exit(1);
  }
  try {
    const existed = gate in GATE_LABELS && fs.existsSync(path.join(projectDir, 'reviews', `${gate}.html`));
    const file = buildReviewPage(projectDir, /** @type {Gate} */ (gate));
    if (noOpen) console.log(file);
    else showPage(file, existed);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
