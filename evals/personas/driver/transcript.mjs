// 記録から、人ごとの全文（やりとり、見えた力、5 つの記録、カード、深める、レポート、本人の一言、答え）を作る。
// 使い方: node evals/personas/driver/transcript.mjs <回> <人>。.run/<回>/<人>/transcript.md に書く
import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
const [run, p] = process.argv.slice(2);
const dir = runDir(run, p);
if (!fs.existsSync(path.join(dir, 'snapshot-end.json')) && !fs.existsSync(path.join(dir, 'snapshot-before-delete.json'))) {
  console.error(`${p}: 終わりの記録（snapshot-end.json）がありません。演じる役が最後に snapshot end を送ったかを確かめてください`);
  process.exit(1);
}
const nd = f => { const x = path.join(dir, f); return fs.existsSync(x) ? fs.readFileSync(x, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; };
const snapFile = fs.existsSync(path.join(dir, 'snapshot-before-delete.json')) ? 'snapshot-before-delete.json' : 'snapshot-end.json';
const snap = JSON.parse(fs.readFileSync(path.join(dir, snapFile), 'utf8'));
const out = [];
const w = s => out.push(s);
const J = o => JSON.stringify(o);

// 話: 場面ごとに、いちばん長いやりとりを残す（消えた話も含める）
const eps = new Map();
for (const e of nd('turns.ndjson')) {
  if (e.status !== 200 || typeof e.body !== 'object') continue;
  const cur = eps.get(e.episode);
  if (!cur || (e.body.turns?.length ?? 0) >= (cur.turns?.length ?? 0)) eps.set(e.episode, e.body);
}
const kept = new Set((snap.episodes || []).map(x => x.body?.id));
for (const x of snap.episodes || []) if (x.body?.id) eps.set(x.body.id, x.body);
let en = 0;
for (const [id, ep] of eps) {
  en += 1;
  w(`\n## 話 ${en}（status=${ep.status}${kept.has(id) ? '' : '、最後に残っていない話'}）`);
  let i = 0;
  for (const t of ep.turns || []) {
    if (t.role === 'assistant') {
      w(`🤖 [${t.move ?? ''}] ${t.text}`);
      if (t.choices?.length) w(`    選択肢: ${t.choices.join(' / ')}`);
    } else {
      i += 1;
      w(`🙋${i} (${t.answerKind ?? t.role}) ${t.text}`);
    }
    const rest = Object.fromEntries(Object.entries(t).filter(([k]) => !['role', 'text', 'choices', 'move', 'at', 'answerKind'].includes(k)));
    if (Object.keys(rest).length) w(`    他: ${J(rest)}`);
  }
  if (ep.notice) w(`  notice: ${J(ep.notice)}`);
  if (ep.insights) w(`  insights: ${J(ep.insights)}`);
}

w('\n## 見えた力');
const ab = snap.abilities.body;
for (const a of ab.abilities) w(`- ${a.name}: life=${a.life} work=${a.work} excluded=${a.excluded}\n    quotes=${J(a.quotes)}\n    hints=${J(a.hints)}`);
w('変わったこと:'); for (const h of ab.history) w(`  ${h.at.slice(11, 19)} ${h.name} ${h.from}→${h.to} (${h.reason})`);

w('\n## 5 つの記録'); w(J(snap.profile.body.records ?? snap.profile.body));

w('\n## カード');
const o = snap.options.body;
w(`readiness=${o.readiness} monthlyIncome=${o.monthlyIncome}`);
if (o.cards) {
  for (const k of ['choose', 'combine', 'create']) w(`- ${k}: ${J(o.cards[k])}`);
  w(`- missing: ${J(o.cards.missing)}`);
}
w(`- ownJobs: ${J(o.ownJobs)}`);
w(`- choice: kind=${o.choice?.kind} card=${o.choice?.card?.kind ?? ''} own=${J(o.choice?.ownJob)}`);

w('\n## 深める');
const d = snap.deepen.body;
w(`readiness=${d.readiness} target=${J(d.target)}`);
if (d.content) {
  for (const t of d.content.tasks) w(`- 業務: ${J(t)}`);
  for (const q of d.content.questions) w(`- 問い: ${J(q)}`);
  for (const s of d.content.steps) w(`- 一歩: ${J(s)}`);
  w(`- 自分の一歩: ${J(d.content.ownSteps)}  stepsFallback=${d.content.stepsFallback}`);
}

w('\n## レポート');
const r = snap.report.body;
w(J(r.content));
w(`版: current=${r.current?.number} changed=${J(r.current?.changed)} previous=${r.previous?.length}`);

w('\n## 本人の一言');
for (const n of nd('notes.ndjson')) w(`- ${n.path.replace(/episode-[0-9a-f]+/, 'ep')}: ${n.text}`);

w('\n## 通信の失敗と画面のエラー');
for (const e of nd('network.ndjson')) if (e.status >= 400 && !/\/api\/me$/.test(e.path)) w(`- ${e.method} ${e.path} ${e.status} ${String(e.body).slice(0, 200)}`);
for (const e of nd('console.ndjson')) if (!/401/.test(e.text)) w(`- console ${e.type}: ${e.text.slice(0, 220)}`);

w('\n## 終わったあとの答え');
w(fs.existsSync(path.join(dir, 'answers.md')) ? fs.readFileSync(path.join(dir, 'answers.md'), 'utf8') : '（答えが残っていない）');
fs.writeFileSync(path.join(dir, 'transcript.md'), out.join('\n'));
console.log(`${p}: ${out.join('\n').length} 文字, 話 ${eps.size} 本`);
