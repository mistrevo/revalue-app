// 記録を、操作した順の流れにする（どこで迷い、どれだけ待ったかを見るため）。
// 使い方: node evals/personas/driver/flow.mjs <回> <人>。標準出力に書く
import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
const [run, p] = process.argv.slice(2);
const dir = runDir(run, p);
const read = f => { const x = path.join(dir, f); return fs.existsSync(x) ? fs.readFileSync(x, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; };
const sse = raw => raw.split(/\r?\n\r?\n/).filter(b => b.trim()).map(b => { let ev = 'message'; const d = []; for (const l of b.split(/\r?\n/)) { if (l.startsWith('event:')) ev = l.slice(6).trim(); else if (l.startsWith('data:')) d.push(l.slice(5).replace(/^ /, '')); } try { return { ev, data: JSON.parse(d.join('\n')) }; } catch { return { ev, data: d.join('\n') }; } });
const all = [
  ...read('actions.ndjson').map(e => ({ t: e.at, k: 'act', e })),
  ...read('network.ndjson').map(e => ({ t: e.at, k: 'net', e })),
  ...read('notes.ndjson').map(e => ({ t: e.at, k: 'note', e })),
  ...read('console.ndjson').map(e => ({ t: e.at, k: 'con', e })),
].sort((a, b) => a.t.localeCompare(b.t));
for (const { k, e } of all) {
  if (k === 'note') console.log(`  💭 ${e.path}: ${e.text}`);
  if (k === 'con') { if (e.type !== 'error' || !/401/.test(e.text)) console.log(`  ⚠ ${e.type}: ${e.text.slice(0, 200)}`); }
  if (k === 'act') {
    if (e.cmd === 'see') continue;
    const a = (e.args || []).join(' / ');
    console.log(`\n▶ ${e.cmd} ${a.slice(0, 200)}  → ${e.path}  (${Math.round((e.waited || 0) / 1000)}秒)`);
  }
  if (k === 'net') {
    const m = e.method, pa = e.path;
    if (m === 'POST' && /\/messages$/.test(pa)) {
      const req = JSON.parse(e.reqBody || '{}');
      console.log(`  🙋 [${req.kind}] ${req.text}`);
      const evs = sse(e.body || '');
      const reply = evs.filter(x => x.ev === 'delta').map(x => x.data.text).join('');
      // 流れる返事の本文は、ブラウザ側からは読めないことがある。全文は transcript.md（サーバーから取ったやりとり）にある
      console.log(`  🤖 ${reply || (String(e.body).startsWith('（本文を読めず') ? '（返事の本文はここでは読めない。transcript.md を見る）' : '')}`);
      const ch = evs.find(x => x.ev === 'choices');
      if (ch) console.log(`     選択肢: ${JSON.stringify(ch.data.choices ?? ch.data)}`);
      for (const n of evs.filter(x => x.ev === 'notice' || x.ev === 'error')) console.log(`     ${n.ev}: ${JSON.stringify(n.data)}`);
      console.log(`     (${e.status}, ${e.ms}ms, イベント: ${[...new Set(evs.map(x => x.ev))].join(',')})`);
    } else if (m !== 'GET') {
      console.log(`  ⇢ ${m} ${pa} ${e.status} ${e.reqBody ? String(e.reqBody).slice(0, 220) : ''}`);
    } else if (e.status >= 400 && !/\/api\/me$/.test(pa)) {
      console.log(`  ⚠ GET ${pa} ${e.status} ${String(e.body).slice(0, 160)}`);
    }
  }
}
