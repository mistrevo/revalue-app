// 提出動画の実画面を記録する常駐の道具。手元の開発モードのアプリをブラウザで動かし、画面の変化をそのまま 1 枚ずつ残す。
// 使い方: node video/demo/recorder.mjs <撮りの名前>。操作は video/demo/rc.mjs から送る
// 残す場所: video/demo/.run/<撮りの名前>/（git に入れない）。frames/ が画面、frames.ndjson と marks.ndjson が時刻
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../evals/personas/driver/node_modules/playwright/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAKE = process.argv[2];
if (!TAKE || !/^[A-Za-z0-9-]{1,40}$/.test(TAKE)) {
  console.error('撮りの名前を英数字とハイフンで渡してください');
  process.exit(2);
}
const BASE = process.env.REVALUE_URL ?? 'http://localhost:5080';
const PORT = Number(process.env.RECORDER_PORT ?? 5198);
const OUT = path.join(HERE, '.run', TAKE);
const FRAMES = path.join(OUT, 'frames');
fs.mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1.5,
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
});

// マウスは記録に映らないので、動きが分かるよう、同じ位置に矢印を描く
await context.addInitScript(() => {
  const add = () => {
    if (document.getElementById('__cursor') || !document.documentElement) return;
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transition:transform .35s cubic-bezier(.3,.8,.3,1);transform:translate(640px,420px)';
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2l15 11-7 1-3.5 7z" fill="#222" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
  };
  add();
  document.addEventListener('DOMContentLoaded', add);
  window.__moveCursor = (x, y) => {
    add();
    document.getElementById('__cursor').style.transform = `translate(${x}px,${y}px)`;
  };
});

const page = await context.newPage();
const inflight = new Set();
let lastActivity = Date.now();
page.on('request', r => { inflight.add(r); lastActivity = Date.now(); });
const done = r => { inflight.delete(r); lastActivity = Date.now(); };
page.on('requestfinished', done);
page.on('requestfailed', done);

// 記録
const cdp = await context.newCDPSession(page);
let frameNo = 0;
let recording = false;
const framesLog = fs.createWriteStream(path.join(OUT, 'frames.ndjson'), { flags: 'a' });
const marksFile = path.join(OUT, 'marks.ndjson');
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  frameNo += 1;
  const name = `${String(frameNo).padStart(6, '0')}.png`;
  fs.writeFile(path.join(FRAMES, name), Buffer.from(data, 'base64'), () => {});
  framesLog.write(JSON.stringify({ name, t: metadata.timestamp }) + '\n');
  try {
    await cdp.send('Page.screencastFrameAck', { sessionId });
  } catch {
    // 閉じたあとの確認は捨てる
  }
});
const startRec = async () => {
  if (recording) return;
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  recording = true;
};
const stopRec = async () => {
  if (!recording) return;
  await cdp.send('Page.stopScreencast');
  recording = false;
};

async function settle(max = 240_000) {
  const started = Date.now();
  await page.waitForTimeout(350);
  while (Date.now() - started < max) {
    if (inflight.size === 0 && Date.now() - lastActivity > 500) break;
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(250);
}

const SCAN = () => {
  const sel = 'a[href],button,input,textarea,select,[role=button],[role=radio],[role=checkbox],[role=link],[role=tab],[role=combobox],summary';
  const els = [];
  document.querySelectorAll('[data-rc-i]').forEach(e => e.removeAttribute('data-rc-i'));
  let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') continue;
    let label = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.getAttribute('placeholder') || el.value || '';
    label = label.replace(/\s+/g, ' ').trim();
    el.setAttribute('data-rc-i', String(i));
    els.push(`[${i}] ${el.tagName.toLowerCase()}${el.disabled ? '（押せない）' : ''}: ${label.slice(0, 80)}`);
    i += 1;
  }
  return { text: document.body.innerText, els, y: window.scrollY, h: document.documentElement.scrollHeight };
};

async function see() {
  const v = await page.evaluate(SCAN);
  return `# ${new URL(page.url()).pathname} (scroll ${v.y}/${v.h})\n${v.text}\n--- 操作 ---\n${v.els.join('\n')}`;
}

async function moveTo(loc) {
  await loc.scrollIntoViewIfNeeded({ timeout: 8000 });
  const b = await loc.boundingBox();
  if (!b) return;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.evaluate(([a, c]) => window.__moveCursor(a, c), [x, y]);
  await page.mouse.move(x, y);
  await page.waitForTimeout(420);
}

const el = n => page.locator(`[data-rc-i="${n}"]`).first();
const mark = name => fs.appendFileSync(marksFile, JSON.stringify({ name, wall: Date.now() / 1000 }) + '\n');

async function handle(cmd, args) {
  switch (cmd) {
    case 'start': {
      const user = args[0] ?? `video-${TAKE}`;
      await page.goto(`${BASE}/.auth/login/google?dev_user=${encodeURIComponent(user)}`, { waitUntil: 'load' });
      await settle();
      return see();
    }
    case 'rec':
      await startRec();
      mark('rec-start');
      return '記録を始めました';
    case 'pause':
      await stopRec();
      mark('rec-pause');
      return '記録を止めました';
    case 'mark':
      mark(args.join(' '));
      return '印を付けました';
    case 'see':
      return see();
    case 'goto':
      await page.goto(BASE + args[0], { waitUntil: 'load' });
      await settle();
      return see();
    case 'click': {
      const loc = el(args[0]);
      await moveTo(loc);
      await loc.click({ timeout: 10_000 });
      await settle();
      return see();
    }
    case 'type': {
      const loc = el(args[0]);
      await moveTo(loc);
      await loc.click({ timeout: 10_000 });
      for (const ch of args.slice(1).join(' ')) {
        await page.keyboard.insertText(ch);
        await page.waitForTimeout(45);
      }
      await page.waitForTimeout(300);
      return see();
    }
    case 'fill':
      await el(args[0]).fill(args.slice(1).join(' '));
      return see();
    case 'select':
      await el(args[0]).selectOption({ label: args.slice(1).join(' ') });
      await settle();
      return see();
    case 'scroll':
      await page.evaluate(d => window.scrollBy({ top: d, behavior: 'smooth' }), Number(args[0]));
      await page.waitForTimeout(Number(args[1] ?? 900));
      return see();
    case 'scrollto':
      await page.getByText(args.join(' '), { exact: false }).first().evaluate(e => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await page.waitForTimeout(900);
      return see();
    case 'wait':
      await page.waitForTimeout(Number(args[0]));
      return '待ちました';
    case 'shot': {
      const file = path.join(OUT, `${args[0] ?? 'shot'}.png`);
      await page.screenshot({ path: file });
      return file;
    }
    case 'stop':
      await stopRec();
      mark('rec-stop');
      framesLog.end();
      setTimeout(async () => {
        await browser.close();
        process.exit(0);
      }, 500);
      return `終わります。枚数 ${frameNo}`;
    default:
      throw new Error(`知らない操作: ${cmd}`);
  }
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', d => { raw += d; });
  req.on('end', async () => {
    let out;
    try {
      const { cmd, args } = JSON.parse(raw);
      out = await handle(cmd, args ?? []);
    } catch (e) {
      out = `【操作できませんでした】${e.message}`;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(out);
  });
});
server.requestTimeout = 0;
server.timeout = 0;
server.listen(PORT, '127.0.0.1', () => console.log(`ready ${PORT} take=${TAKE} out=${OUT}`));
