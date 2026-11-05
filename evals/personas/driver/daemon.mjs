// ペルソナごとに別のブラウザの文脈を持ち、操作と通信を全部記録する常駐の道具。
// 使い方: node evals/personas/driver/daemon.mjs <回の名前（例: 2026-11-05-r1）>
// 操作は pw.mjs から送る。記録は evals/personas/.run/<回>/<人>/ に残す（git に入れない）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { BASE, DRIVER_PORT as PORT, PEOPLE, PERSONAS, runDir } from './paths.mjs';

const RUN = process.argv[2];
if (!RUN || !/^[A-Za-z0-9-]{1,40}$/.test(RUN)) {
  console.error('回の名前を英数字とハイフンで渡してください（例: 2026-11-05-r1）');
  process.exit(2);
}
const OUT = runDir(RUN);

const MOBILE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1280, height: 800 } };

/** 人物ファイルの「使う場面」に 1280px とあれば PC の幅、ほかはスマホの幅で開く。 */
function deviceFor(persona) {
  const file = PERSONAS[persona] ? path.join(PEOPLE, `${PERSONAS[persona]}.md`) : null;
  const text = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return text.includes('1280px') ? DESKTOP : MOBILE;
}

const browser = await chromium.launch({ headless: true });
const sessions = new Map();

function log(s, file, entry) {
  fs.appendFileSync(path.join(s.dir, file), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

async function createSession(persona) {
  if (!/^[a-z]$/.test(persona)) throw new Error('人は a〜z の 1 文字で指定してください');
  const dir = path.join(OUT, persona);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const devUser = `persona-${persona}-${RUN}`;
  const context = await browser.newContext({ ...deviceFor(persona), locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const s = { persona, devUser, dir, context, page: null, inflight: new Set(), lastActivity: Date.now(), seq: 0, shot: 0, els: [] };
  return s;
}

async function attachPage(s) {
  const page = await s.context.newPage();
  s.page = page;
  page.on('request', r => {
    s.inflight.add(r); s.lastActivity = Date.now();
    r.__t = Date.now();
  });
  const done = async (r, failed) => {
    s.inflight.delete(r); s.lastActivity = Date.now();
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api') && !u.pathname.startsWith('/.auth')) return;
    let status = null, body = null;
    try {
      const res = await r.response();
      status = res?.status() ?? null;
      if (res && !(status >= 300 && status < 400)) body = await res.text();
    } catch (e) { body = `（本文を読めず: ${e.message}）`; }
    log(s, 'network.ndjson', { method: r.method(), path: u.pathname + u.search, reqBody: r.postData(), status, body, ms: Date.now() - r.__t, failed: !!failed });
  };
  page.on('requestfinished', r => done(r, false));
  page.on('requestfailed', r => done(r, true));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') log(s, 'console.ndjson', { type: m.type(), text: m.text() }); });
  page.on('pageerror', e => log(s, 'console.ndjson', { type: 'pageerror', text: String(e) }));
  return page;
}

async function settle(s, max = 240_000) {
  const started = Date.now();
  await s.page.waitForTimeout(350);
  while (Date.now() - started < max) {
    if (s.inflight.size === 0 && Date.now() - s.lastActivity > 500) break;
    await s.page.waitForTimeout(150);
  }
  await s.page.waitForTimeout(250);
  return Date.now() - started;
}

const SCAN = () => {
  const sel = 'a[href],button,input,textarea,select,[role=button],[role=radio],[role=checkbox],[role=link],[role=tab],[role=combobox],summary';
  const list = [];
  let i = 0;
  document.querySelectorAll('[data-pw-i]').forEach(e => e.removeAttribute('data-pw-i'));
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || '';
    const role = el.getAttribute('role') || '';
    let kind = 'ボタン';
    if (tag === 'a' || role === 'link') kind = 'リンク';
    else if (tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'submit', 'button'].includes(type))) kind = '入力欄';
    else if (tag === 'select' || role === 'combobox') kind = '選択欄';
    else if (type === 'checkbox' || role === 'checkbox') kind = 'チェック';
    else if (type === 'radio' || role === 'radio') kind = 'ラジオ';
    else if (tag === 'summary') kind = '開閉';
    let label = el.getAttribute('aria-label') || '';
    if (!label && el.labels && el.labels[0]) label = el.labels[0].innerText;
    if (!label) label = el.innerText || el.getAttribute('placeholder') || el.value || '';
    label = label.replace(/\s+/g, ' ').trim();
    const info = { i, kind, label, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' };
    if (kind === '入力欄') { info.value = el.value; info.placeholder = el.getAttribute('placeholder') || ''; }
    if (kind === 'チェック' || kind === 'ラジオ') info.checked = el.checked === true || el.getAttribute('aria-checked') === 'true';
    if (tag === 'select') { info.value = el.value; info.options = [...el.options].map(o => o.text); }
    if (tag === 'a') info.external = el.target === '_blank';
    el.setAttribute('data-pw-i', String(i));
    list.push(info);
    i += 1;
  }
  return { text: document.body.innerText, els: list };
};

function renderEl(e) {
  let line = `[${e.i}] ${e.kind}: ${e.label || '（名前なし）'}`;
  if (e.value !== undefined && e.kind === '入力欄') line += `（いまの中身: ${e.value ? `「${e.value}」` : '空'}）`;
  if (e.value !== undefined && e.kind === '選択欄') line += `（いまの値: ${e.value} / 選べるもの: ${(e.options || []).join('、')}）`;
  if (e.checked !== undefined) line += e.checked ? '（選択済み）' : '（未選択）';
  if (e.disabled) line += '（いまは押せない）';
  if (e.external) line += '（新しいタブ）';
  return line;
}

async function view(s) {
  const data = await s.page.evaluate(SCAN);
  s.els = data.els;
  const u = new URL(s.page.url());
  return { path: u.pathname + u.search, text: data.text, els: data.els };
}

function render(v) {
  return `# 画面 ${v.path}\n\n--- 画面に見えている文字 ---\n${v.text}\n\n--- 操作できるもの（番号で指定する）---\n${v.els.map(renderEl).join('\n')}\n`;
}

async function shot(s, label) {
  s.shot += 1;
  const name = `${String(s.shot).padStart(3, '0')}-${label.replace(/[^\p{L}\p{N}-]+/gu, '_').slice(0, 40)}.jpg`;
  try {
    await s.page.screenshot({ path: path.join(s.dir, 'shots', name), fullPage: true, type: 'jpeg', quality: 60, timeout: 20_000 });
  } catch (e) { log(s, 'console.ndjson', { type: 'harness', text: `写真を撮れず: ${e.message}` }); }
  return name;
}

async function snapshot(s, label) {
  const get = async p => {
    const r = await s.context.request.get(BASE + p);
    const t = await r.text();
    try { return { status: r.status(), body: JSON.parse(t) }; } catch { return { status: r.status(), body: t }; }
  };
  const list = await get('/api/episodes');
  const items = Array.isArray(list.body) ? list.body : (list.body?.episodes ?? []);
  const episodes = [];
  for (const e of items) episodes.push(await get(`/api/episodes/${e.id}`));
  const snap = { label, at: new Date().toISOString(), list, episodes, abilities: await get('/api/abilities'), profile: await get('/api/profile'), options: await get('/api/options'), deepen: await get('/api/deepen'), report: await get('/api/report'), stats: await get('/api/stats') };
  fs.writeFileSync(path.join(s.dir, `snapshot-${label}.json`), JSON.stringify(snap, null, 2));
  return `snapshot-${label}.json`;
}

async function afterAction(s, cmd, args) {
  const waited = await settle(s);
  const v = await view(s);
  const name = cmd === 'type' ? null : await shot(s, `${cmd}-${v.path.split('?')[0].replaceAll('/', '_')}`);
  log(s, 'actions.ndjson', { seq: ++s.seq, cmd, args, path: v.path, waited, shot: name, text: v.text, els: v.els.map(renderEl) });
  // 話の全文はサーバーから取って残す（ストリームの本文はブラウザから読めない。あとで「残さず」に消える話も残すため）
  const talk = v.path.match(/^\/talk\/([^/?]+)/);
  if (talk && cmd !== 'type') {
    const r = await s.context.request.get(`${BASE}/api/episodes/${talk[1]}`).catch(() => null);
    if (r) {
      const t = await r.text();
      log(s, 'turns.ndjson', { episode: talk[1], status: r.status(), body: t.startsWith('{') ? JSON.parse(t) : t });
    }
  }
  if (v.path.startsWith('/report')) await snapshot(s, 'at-report').catch(() => {});
  return render(v);
}

async function handle(persona, cmd, args) {
  let s = sessions.get(persona);
  if (cmd === 'start') {
    if (s) throw new Error('すでに始めています。see で画面を見てください');
    s = await createSession(persona);
    sessions.set(persona, s);
    await attachPage(s);
    await s.page.goto(BASE + '/', { waitUntil: 'load' });
    return afterAction(s, cmd, args);
  }
  if (!s) throw new Error('先に start してください');
  if (cmd === 'reopen') {
    if (s.page && !s.page.isClosed()) throw new Error('ページはまだ開いています');
    await attachPage(s);
    await s.page.goto(BASE + '/', { waitUntil: 'load' });
    return afterAction(s, cmd, args);
  }
  if (cmd === 'note') {
    log(s, 'notes.ndjson', { path: s.page && !s.page.isClosed() ? new URL(s.page.url()).pathname : '（閉じている）', text: args.join(' ') });
    return '書き留めました';
  }
  if (cmd === 'snapshot') return snapshot(s, args[0] ?? 'end');
  if (cmd === 'answers') {
    // 使い終えたあとの答え（how-to-play.md の「終わったら答えること」）。何度送っても、最後のものを残す
    fs.writeFileSync(path.join(s.dir, 'answers.md'), args.join(' '));
    return '答えを残しました';
  }
  if (!s.page || s.page.isClosed()) throw new Error('ページは閉じています。reopen で開き直してください');
  if (cmd === 'see') {
    const v = await view(s);
    return render(v);
  }
  if (cmd === 'close') {
    await settle(s, 30_000);
    log(s, 'actions.ndjson', { seq: ++s.seq, cmd, args, path: new URL(s.page.url()).pathname, text: '（ページを閉じた）', els: [] });
    await s.page.close();
    return 'ページを閉じました。開き直すときは reopen';
  }
  if (cmd === 'back') {
    await s.page.goBack();
    return afterAction(s, cmd, args);
  }
  const n = Number(args[0]);
  const target = s.els.find(e => e.i === n);
  if (!target) throw new Error(`番号 ${args[0]} はありません。see で番号を確かめてください`);
  const loc = s.page.locator(`[data-pw-i="${n}"]`).first();
  if (cmd === 'click') {
    if (target.label.includes('消す') && new URL(s.page.url()).pathname.startsWith('/settings')) await snapshot(s, 'before-delete').catch(() => {});
    if (target.label.includes('Google でログイン')) {
      // 画面のログインは、その人の名前で偽のログインをする（押した先と同じ行き先へ進む）
      const href = await loc.getAttribute('href').catch(() => null);
      const u = new URL(href || '/.auth/login/google', BASE);
      u.searchParams.set('dev_user', s.devUser);
      await s.page.goto(u.toString(), { waitUntil: 'load' });
      const cookie = (await s.context.cookies()).find(c => c.name === 'revalue_dev_user');
      if (cookie?.value !== s.devUser) throw new Error(`ログイン名が違います: ${cookie?.value}`);
      log(s, 'clicks.ndjson', { n, kind: target.kind, label: target.label, devUser: cookie.value });
      return afterAction(s, cmd, [target.label]);
    }
    if (target.kind === 'チェック' || target.kind === 'ラジオ') {
      await loc.click({ timeout: 6000, force: false }).catch(() => loc.click({ timeout: 6000, force: true }));
    } else {
      await loc.click({ timeout: 10_000 });
    }
    log(s, 'clicks.ndjson', { n, kind: target.kind, label: target.label });
    return afterAction(s, cmd, [target.label]);
  }
  if (cmd === 'type') {
    const text = args.slice(1).join(' ');
    await loc.fill(text, { timeout: 10_000 });
    return afterAction(s, cmd, [target.label, text]);
  }
  if (cmd === 'select') {
    await loc.selectOption({ label: args.slice(1).join(' ') }, { timeout: 10_000 });
    return afterAction(s, cmd, [target.label, args.slice(1).join(' ')]);
  }
  throw new Error(`知らない操作: ${cmd}`);
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', d => { raw += d; });
  req.on('end', async () => {
    let out;
    try {
      const { persona, cmd, args } = JSON.parse(raw);
      if (cmd === 'shutdown') {
        res.end('終了します');
        await browser.close();
        process.exit(0);
      }
      out = await handle(persona, cmd, args ?? []);
    } catch (e) {
      out = `【操作できませんでした】${e.message}`;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(out);
  });
});
server.requestTimeout = 0;
server.timeout = 0;
server.listen(PORT, '127.0.0.1', () => console.log(`ready ${PORT} run=${RUN} out=${OUT}`));
