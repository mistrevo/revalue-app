// 機械で確かめられる項目（how-to-judge.md の「芯に反していないか」のうち、文字列と数で見られるもの）を、記録に当てる。
// 使い方: node evals/personas/driver/check.mjs <回> [人...]。人を省くと、記録のある人すべて。結果は標準出力と .run/<回>/checks.md に書く
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runDir } from './paths.mjs';
const [runName, ...only] = process.argv.slice(2);
if (!runName) { console.error('使い方: node evals/personas/driver/check.mjs <回> [人...]'); process.exit(2); }
const RUN = runDir(runName);
const people = only.length ? only : fs.readdirSync(RUN).filter(d => /^[a-z]$/.test(d) && fs.statSync(path.join(RUN, d)).isDirectory()).sort();
const nd = (p, f) => { const x = path.join(RUN, p, f); return fs.existsSync(x) ? fs.readFileSync(x, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; };
const forbidden = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/shared/forbidden-words.json'), 'utf8'));
const jobs = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/Revalue.Server/Features/Options/jobs.json'), 'utf8'));
// 残さないと選んだ話の言葉。そのあとの画面と保存データに出ないかを見る（いまは people/e-sayaka.md の話 1 の言葉）
const LEAK_WORDS = { e: ['眠れなく', '投げ出', '消えてしまいたい', 'しんどい'] };
const lines = [];
const out = t => { console.log(t); lines.push(t); };
// カードに使う（active）業務だけを登録として数える。準備中の業務と、カードに使う業務のない職種は、登録していないものとして数える
const taskIds = new Map(); for (const o of jobs.occupations) for (const t of o.tasks) if (t.status === 'active') taskIds.set(t.id, { ...t, occ: o.name });
const occNames = new Set(jobs.occupations.filter(o => o.tasks.some(t => t.status === 'active')).map(o => o.name));
const stateWords = ['根拠あり', '要確認', '未確認'];
const praise = ['素晴らしい', 'すごい', 'すばらしい', '立派', '完璧', '才能', 'さすが', '向いています', '向いている', 'ぴったり', '間違いなく', 'おすすめ'];
const SLOT = { morning: 1, daytime: 1, evening: 1, night: 1 };

for (const p of people) {
  if (!fs.existsSync(path.join(RUN, p, 'snapshot-end.json')) && !fs.existsSync(path.join(RUN, p, 'snapshot-before-delete.json'))) {
    out(`\n=== ${p}
  終わりの記録（snapshot-end.json）がないので確かめられない`);
    continue;
  }
  const res = [];
  const file = fs.existsSync(path.join(RUN, p, 'snapshot-before-delete.json')) ? 'snapshot-before-delete.json' : 'snapshot-end.json';
  const snap = JSON.parse(fs.readFileSync(path.join(RUN, p, file), 'utf8'));
  // 話の全文
  const eps = new Map();
  for (const e of nd(p, 'turns.ndjson')) { if (e.status === 200 && typeof e.body === 'object') { const c = eps.get(e.episode); if (!c || e.body.turns.length >= c.turns.length) eps.set(e.episode, e.body); } }
  for (const x of snap.episodes) eps.set(x.body.id, x.body);
  const userTexts = []; const asstTurns = [];
  for (const ep of eps.values()) for (const t of ep.turns) { if (t.role === 'user') userTexts.push(t.text); else asstTurns.push(t); }
  const allUser = userTexts.join('\n');
  // 引用の一致
  const quotes = [];
  const collect = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(collect); if (typeof o.text === 'string' && 'fromChoice' in o && 'linkedText' in o) quotes.push(o); Object.values(o).forEach(collect); };
  collect(snap.abilities.body); collect(snap.options.body); collect(snap.deepen.body); collect(snap.report.body);
  const bad = quotes.filter(q => !allUser.includes(q.text));
  const badLinked = quotes.filter(q => q.linkedText && !allUser.includes(q.linkedText));
  res.push(`引用 ${quotes.length} 個（延べ）: 本人の発言と不一致 ${bad.length} / 結びつけ先の不一致 ${badLinked.length}${bad.length ? ' → ' + bad.map(q => q.text).join(' | ') : ''}`);
  // 問いの数（受け止めてから問いを一つ）
  const rows = asstTurns.filter(t => !['opening', 'close', 'distress', 'afterSkip'].includes(t.move));
  const q2 = rows.filter(t => (t.text.match(/[？?]/g) || []).length !== 1);
  res.push(`聞き手の返事 ${asstTurns.length}（締め・つらい話などを除く ${rows.length}）: 問いが一つでない ${q2.length}${q2.length ? ' → ' + q2.map(t => t.text.slice(-50)).join(' | ') : ''}`);
  const onlyQ = rows.filter(t => t.text.split(/[。]/).length < 2);
  res.push(`問いだけの返事 ${onlyQ.length}`);
  // 画面の文字
  const acts = nd(p, 'actions.ndjson');
  const allText = acts.map(a => a.text).join('\n');
  const hit = (list, t = allText) => list.filter(w => t.includes(w));
  // 使わない言葉は、聞き手の返事とアプリの画面に対して見る。本人の入力は除く
  const noUser = userTexts.reduce((t, u) => t.split(u).join(''), allText);
  res.push(`使わない言葉: ${hit(forbidden, noUser).join('、') || 'なし'} / 状態の呼び名: ${hit(stateWords, noUser).join('、') || 'なし'} / 褒め・断定の語: ${hit(praise, noUser).join('、') || 'なし'}`);
  // カードの条件
  const o = snap.options.body; const c = snap.profile.body.conditions;
  const cards = o.cards;
  if (cards) {
    const issues = [];
    for (const k of ['choose', 'combine']) {
      const card = cards[k]; if (!card) continue;
      for (const t of card.tasks) {
        const reg = taskIds.get(t.id);
        if (!reg) issues.push(`${k}: 未登録 ${t.id}`);
        else {
          if (reg.hoursPerWeek.min > c.hoursPerWeek) issues.push(`${k}: ${t.name} の時間`);
          if (!reg.timeSlots.some(s => c.timeSlots.includes(s))) issues.push(`${k}: ${t.name} の時間帯`);
          if (reg.place === 'out' && c.place !== 'canGoOut') issues.push(`${k}: ${t.name} の場所`);
        }
      }
      if (card.range.maxHours > c.hoursPerWeek) issues.push(`${k}: 幅の上限が条件を超える`);
      if (k === 'choose' && !occNames.has(card.occupationName)) issues.push(`未登録の職種 ${card.occupationName}`);
    }
    if (cards.create) {
      const cr = cards.create;
      if (cr.hoursPerWeek > c.hoursPerWeek) issues.push('create: 時間');
      if (!cr.timeSlots.every(s => c.timeSlots.includes(s))) issues.push('create: 時間帯');
      if (cr.place === 'out' && c.place !== 'canGoOut') issues.push('create: 場所');
      if (/[0-9０-９]+\s*(円|万)/.test(JSON.stringify(cr))) issues.push('create: お金の額');
    }
    const fmt = r => r ? `月${r.minMonthlyYen / 10000}〜${r.maxMonthlyYen / 10000}万` : '-';
    res.push(`カード: 選ぶ=${cards.choose?.occupationName ?? 'なし'}(${fmt(cards.choose?.range)}) 組=${cards.combine?.roleName ?? 'なし'}(${fmt(cards.combine?.range)}) 創=${cards.create?.title ?? 'なし'} 出せない=${(cards.missing || []).map(m => `${m.kind}:${m.reason}`).join(',') || 'なし'} / 条件違反 ${issues.length}${issues.length ? ' → ' + issues.join(' | ') : ''} / 目安 ${c.monthlyIncome ?? '未定'}万`);
    const reasons = ['choose', 'combine', 'create'].map(k => cards[k]?.reason).filter(Boolean);
    res.push(`カードの理由の言い切り: ${reasons.filter(r => !/かもしれません/.test(r)).length} / ${reasons.length} が「かもしれません」以外`);
  }
  // 深める
  const d = snap.deepen.body.content;
  if (d) {
    res.push(`深める: 一歩の候補 ${d.steps.length}（条件の外 ${d.steps.filter(s => !s.fits).length}、需要の確かめ ${d.steps.filter(s => s.demandCheck).length}、決まった候補に置き換え ${d.stepsFallback}）`);
  }
  // 残さないと選んだ話の言葉が、そのあとの画面と保存データに出ないか
  const distress = LEAK_WORDS[p] ?? [];
  const i = acts.findIndex(a => (a.args || []).some(x => String(x).includes('残さずに、別の話にする')));
  if (distress.length && i >= 0) {
    const later = acts.slice(i + 1);
    const leak = later.filter(a => distress.some(w => a.text.includes(w)));
    res.push(`つらい話: 「別の話にする」を押した行 ${i}、以降の画面 ${later.length} 枚のうち、つらい言葉が出た画面 ${leak.length}`);
    const sn = JSON.stringify({ a: snap.abilities.body.abilities, p: snap.profile.body, o: snap.options.body, d: snap.deepen.body, r: snap.report.body, l: snap.list.body });
    res.push(`つらい話: 消す前の保存データ（力、記録、カード、深める、レポート、話の一覧）に出たか: ${distress.filter(w => sn.includes(w)).join('、') || 'なし'}`);
  }
  // 全部消したとき: 消す前の記録があれば、消したあとの状態を見る
  if (fs.existsSync(path.join(RUN, p, 'snapshot-before-delete.json'))) {
    const end = JSON.parse(fs.readFileSync(path.join(RUN, p, 'snapshot-end.json'), 'utf8'));
    res.push(`全部消したあと: 話の一覧 ${end.list.status}, 力 ${end.abilities.status}, 記録 ${end.profile.status}, レポート ${end.report.status}`);
    const last = acts[acts.length - 1]; res.push(`最後の画面 ${last.path}: ${last.text.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  // 返事の時間
  const sends = nd(p, 'network.ndjson').filter(e => /\/messages$/.test(e.path)).map(e => e.ms);
  const gens = nd(p, 'network.ndjson').filter(e => e.method === 'POST' && /\/api\/(options|deepen)$/.test(e.path)).map(e => `${e.path.split('/').pop()} ${Math.round(e.ms / 1000)}秒`);
  res.push(`返事の時間: ${sends.length} 回、中央 ${Math.round(sends.slice().sort((x, y) => x - y)[sends.length >> 1] / 1000)} 秒、最長 ${Math.round(Math.max(...sends) / 1000)} 秒 / 生成: ${gens.join('、')}`);
  // 通信エラー
  const errs = nd(p, 'network.ndjson').filter(e => e.status >= 400 && !/\/api\/me$/.test(e.path));
  res.push(`通信エラー ${errs.length}${errs.length ? ' → ' + errs.map(e => `${e.method} ${e.path} ${e.status}`).join(', ') : ''} / 画面のエラー ${nd(p, 'console.ndjson').filter(e => !/401/.test(e.text)).length}`);
  out(`\n=== ${p}`); res.forEach(r => out('  ' + r));
}
fs.writeFileSync(path.join(RUN, 'checks.md'), ['# 機械の確かめ', '', '```', ...lines, '```', ''].join('\n'));
