// 道具が動くかを 1 往復だけで確かめる（本物の AI を 1 回呼ぶ。約 $0.06）
// node evals/personas/smoke.mjs（サーバーが http://localhost:5080 で動いていること。別の URL は REVALUE_URL で渡す）
import { login } from './revalue-client.mjs';

const c = await login('smoke-kit');
await c.consent();
const ep = await c.startEpisode();
console.log('最初の問い:', ep.turns.at(-1).text);
const r = await c.send(ep.id, '昨日は夕方に、子どもを習い事に送ったあと、スーパーで夕飯の買い物をしました。', 'free');
console.log(`返事（${r.ms} ms）:`, r.reply);
console.log('選択肢:', r.choices, '/ notice:', r.notices.length, '/ error:', r.error, '/ done:', r.done);
const snap = await c.snapshot();
console.log('snapshot:', Object.keys(snap).join(', '), '/ 場面の数:', snap.episodes.length, '/ 往復:', snap.episodes[0]?.turns.length);
console.log('options.readiness:', snap.options.readiness, '/ deepen.readiness:', snap.deepen.readiness, '/ report.ready:', snap.report.ready);
