// ns-motion-studio のブラウザ側ランタイム。シーンの HTML へ、読み込みの前に注入される（scene-page.mjs の injectScene）。
// シーンの HTML からは <script src> で読まない。プラグインの場所をシーンに書かずに済ませるため。
//
// 決定論の約束: 同じ時刻を seek すれば同じ画素になる。そのために次を封じ込める。
// - Date.now / Date() / new Date() / performance.now は seek の時刻を返す。
// - requestAnimationFrame は、次の seek でその時刻を渡して一度だけ呼ぶ。
// - setTimeout / setInterval は、読み込みの間（ready() が終わるまで）だけ本物のまま使える（外部の部品の初期化のため）。
//   ready() の後に呼ぶと例外を投げる。動きは draw(t) の中で時刻 t から決める。
// - Math.random と crypto.getRandomValues / randomUUID は ms.rand（seed から作る mulberry32）を使う。
//   draw の直前に seed から始め直す。
// - CSS のトランジションは止める（前のフレームの値から動き出し、撮る順序で絵が変わるため）。
// - CSS のアニメーションと Web Animations は、seek のたびに止めて currentTime をシーンの時刻にそろえる
//   （シーンの先頭で始まったものとして扱う。開始のずれは animation-delay で書く）。
// - GSAP を使うときは、タイムラインを paused で作り、draw の中で tl.seek(t) を呼ぶ（GSAP 自身の時計に任せない）。
//
// 起動時の値: window.__MS_INIT = {sceneId, ratio, width, height, seed, slice}。slice は timeline.mjs の sceneSlice の結果。
(function () {
  'use strict';
  if (window.__ms) return;

  const init = window.__MS_INIT || {
    sceneId: null, ratio: '16:9', width: 1920, height: 1080, seed: 1,
    slice: { scene: { start: 0, end: 0 }, texts: [], narration: [], sfx: [] },
  };
  const texts = new Map(init.slice.texts.map((t) => [t.id, t.text]));

  /** いまのシーン内の時刻（秒） */
  let now = 0;
  /** @type {((t: number, api: object) => void) | null} */
  let draw = null;
  let domReady = document.readyState !== 'loading';
  const domReadyP = new Promise((resolve) => {
    if (domReady) resolve();
    else document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });

  // ---- シード付き乱数 ----
  const seed = (Number(init.seed) || 0) >>> 0;
  let state = seed;
  /** mulberry32。[0, 1) を返す */
  function rand() {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  }
  Math.random = rand;

  /** 型付き配列を ms.rand のバイトで埋める */
  function getRandomValues(arr) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rand() * 256);
    return arr;
  }
  function randomUUID() {
    const b = getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  if (window.crypto) {
    Object.defineProperty(crypto, 'getRandomValues', { value: getRandomValues, configurable: true });
    Object.defineProperty(crypto, 'randomUUID', { value: randomUUID, configurable: true });
  }

  // ---- 時計の封じ込め ----
  /** Date の基準時刻（固定）。シーンの時刻 0 がこの瞬間になる */
  const EPOCH = Date.UTC(2026, 0, 1);
  const RealDate = Date;
  const frozenMs = () => EPOCH + now * 1000;
  /** new を付ければ Date を、付けなければ本物と同じく時刻の文字列を返す */
  function FrozenDate(...args) {
    if (!new.target) return new RealDate(frozenMs()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [frozenMs()] : args, new.target);
  }
  FrozenDate.prototype = RealDate.prototype;
  FrozenDate.now = frozenMs;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  window.Date = FrozenDate;
  Object.defineProperty(performance, 'now', { value: () => now * 1000, configurable: true });

  // タイマー: 読み込みの間（ready() が終わるまで）は本物のまま動かし、外部の部品が初期化できるようにする。
  // ready() の後に呼ぶと、撮る順序で絵が変わる原因になるので止める（例外を投げる）。
  const realSetTimeout = window.setTimeout.bind(window);
  const realSetInterval = window.setInterval.bind(window);
  let timersLocked = false;
  const TIMER_ERROR = 'シーンでは setTimeout / setInterval を使えません。動きは draw(t) の中で時刻 t から決めてください。';
  window.setTimeout = (...args) => {
    if (timersLocked) throw new Error(TIMER_ERROR);
    return realSetTimeout(...args);
  };
  window.setInterval = (...args) => {
    if (timersLocked) throw new Error(TIMER_ERROR);
    return realSetInterval(...args);
  };

  let rafQueue = new Map();
  let rafId = 0;
  window.requestAnimationFrame = (cb) => {
    rafQueue.set(++rafId, cb);
    return rafId;
  };
  window.cancelAnimationFrame = (id) => {
    rafQueue.delete(id);
  };

  // ---- イージングとばね ----
  /** cubic-bezier(x1, y1, x2, y2) と同じ形の関数を作る */
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (u) => ((ax * u + bx) * u + cx) * u;
    const sy = (u) => ((ay * u + by) * u + cy) * u;
    const dsx = (u) => (3 * ax * u + 2 * bx) * u + cx;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      // ニュートン法で媒介変数を求め、収束しなければ二分法に切り替える
      let u = x;
      for (let i = 0; i < 8; i++) {
        const e = sx(u) - x;
        if (Math.abs(e) < 1e-7) return sy(u);
        const d = dsx(u);
        if (Math.abs(d) < 1e-6) break;
        u -= e / d;
      }
      let lo = 0, hi = 1;
      u = x;
      for (let i = 0; i < 50; i++) {
        const v = sx(u);
        if (Math.abs(v - x) < 1e-7) break;
        if (v < x) lo = u;
        else hi = u;
        u = (lo + hi) / 2;
      }
      return sy(u);
    };
  }
  const ease = {
    outExpo: bezier(0.16, 1, 0.3, 1),
    outQuint: bezier(0.22, 1, 0.36, 1),
    inOutCubic: bezier(0.76, 0, 0.24, 1),
    inQuart: bezier(0.7, 0, 0.84, 0),
    outBack: bezier(0.34, 1.56, 0.64, 1),
  };

  /**
   * 0 から 1 へ向かうばね（質量 1、初速 0）。t は秒。
   * @param {{damping?: number, stiffness?: number}} [opts]
   */
  function spring({ damping = 10, stiffness = 100 } = {}) {
    if (!(Number.isFinite(stiffness) && stiffness > 0)) throw new Error(`ばねの stiffness は 0 より大きい数にしてください（${stiffness}）`);
    if (!(Number.isFinite(damping) && damping >= 0)) throw new Error(`ばねの damping は 0 以上の数にしてください（${damping}）`);
    const w0 = Math.sqrt(stiffness);
    const zeta = damping / (2 * w0);
    return (t) => {
      if (t <= 0) return 0;
      // 臨界減衰のすぐそばは、下の2つの式が桁落ちするので臨界減衰の式で計算する
      if (Math.abs(zeta - 1) < 1e-6) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
      if (zeta < 1) {
        const wd = w0 * Math.sqrt(1 - zeta * zeta);
        return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
      }
      const s = w0 * Math.sqrt(zeta * zeta - 1);
      const r1 = -zeta * w0 + s, r2 = -zeta * w0 - s;
      return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
    };
  }

  // ---- 正本の文字 ----
  /** timeline.json の文字を返す。無い id は誤りとして止める */
  function text(id) {
    if (!texts.has(id)) throw new Error(`テキスト ${id} が timeline.json にありません（シーン ${init.sceneId}）`);
    return texts.get(id);
  }

  /** timeline.json のそのテキストが出る時刻と消える時刻（シーン内の秒）。動きの始まりを正本の時刻に合わせるために使う */
  function time(id) {
    const t = init.slice.texts.find((x) => x.id === id);
    if (!t) throw new Error(`テキスト ${id} が timeline.json にありません（シーン ${init.sceneId}）`);
    return { start: t.start, end: t.end };
  }

  /** data-ms-text の要素へ正本の文字を流し込む */
  function fillTexts() {
    for (const el of document.querySelectorAll('[data-ms-text]')) {
      const s = text(el.getAttribute('data-ms-text'));
      if (el.textContent !== s) el.textContent = s;
    }
  }

  /** <html> ができたら、比率の印と、トランジションを止めるスタイルを付ける */
  let rootDone = false;
  function setupRoot() {
    const root = document.documentElement;
    if (!root || rootDone) return;
    rootDone = true;
    root.setAttribute('data-ratio', init.ratio);
    const style = document.createElement('style');
    style.setAttribute('data-ms-runtime', '');
    style.textContent = '*, *::before, *::after { transition: none !important; }';
    root.appendChild(style);
  }

  // ---- 描画 ----
  /** シーン内の時刻 t（秒）で描く */
  function seek(t) {
    now = Number(t);
    fillTexts();
    state = seed;
    if (draw) draw(now, ms);
    const queue = rafQueue;
    rafQueue = new Map();
    for (const cb of queue.values()) cb(now * 1000);
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = now * 1000;
    }
  }

  // ---- 読み込みの確認 ----
  const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
    'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont']);
  const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  /** 文字を持つ要素（script / style などを除く） */
  function textElements() {
    const out = new Set();
    if (!document.body) return out;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (el && !SKIP.has(el.tagName) && n.data.trim()) out.add(el);
    }
    return out;
  }

  /** @font-face で宣言されていない名前が、この PC に入っているか（総称フォントとの幅の違いで見る） */
  const ctx = document.createElement('canvas').getContext('2d');
  function installed(family) {
    const sample = 'mmmmmmmmmmlli WwQ@# 永あア';
    for (const base of ['monospace', 'serif', 'sans-serif']) {
      ctx.font = `72px ${base}`;
      const w = ctx.measureText(sample).width;
      ctx.font = `72px "${family}", ${base}`;
      if (ctx.measureText(sample).width !== w) return true;
    }
    return false;
  }

  /** 使われているのに読み込めなかったフォント名 */
  function missingFonts() {
    /** @type {Map<string, string[]>} 宣言されたフォント名（小文字）→ 各書体の状態 */
    const declared = new Map();
    for (const f of document.fonts) {
      const k = unquote(f.family).toLowerCase();
      declared.set(k, [...(declared.get(k) || []), f.status]);
    }
    const available = (fam) => {
      const st = declared.get(fam.toLowerCase());
      if (st) return !st.every((s) => s === 'error');
      return installed(fam);
    };
    const missing = new Set();
    // 宣言したのに全部読み込めなかったもの
    for (const [k, st] of declared) {
      if (st.every((s) => s === 'error')) {
        for (const f of document.fonts) if (unquote(f.family).toLowerCase() === k) missing.add(unquote(f.family));
      }
    }
    // 名前で指定したフォントがどれも無く、総称フォントに落ちているもの
    const seen = new Set();
    for (const el of textElements()) {
      const list = getComputedStyle(el).fontFamily;
      if (seen.has(list)) continue;
      seen.add(list);
      const named = list.split(',').map(unquote).filter((f) => f && !GENERIC.has(f.toLowerCase()));
      if (named.length > 0 && !named.some(available)) missing.add(named[0]);
    }
    return [...missing];
  }

  /** 読み込みが終わった（または失敗した）画像のうち、表示できないものの src */
  async function brokenImages() {
    const imgs = [...document.images].filter((img) => img.getAttribute('src'));
    await Promise.all(imgs.map((img) => (img.complete ? null : img.decode().catch(() => {}))));
    return imgs.filter((img) => img.naturalWidth === 0).map((img) => img.currentSrc || img.src);
  }

  /**
   * フォントと画像の読み込みを待つ。読み込めなかったものがあれば、
   * missingFonts（フォント名）と brokenImages（画像の src）を付けて reject する。
   */
  async function ready() {
    let images, fonts;
    try {
      await domReadyP;
      fillTexts();
      void document.body.offsetHeight; // 文字の配置を確定させ、使うフォントの読み込みを始めさせる
      await document.fonts.ready;
      images = await brokenImages();
      await document.fonts.ready;
      fonts = missingFonts();
    } finally {
      // ここから先は撮る段階。タイマーは使えなくする（読み込みに失敗しても同じ）
      timersLocked = true;
    }
    if (fonts.length > 0 || images.length > 0) {
      const parts = [];
      if (fonts.length > 0) parts.push(`読み込めなかったフォント: ${fonts.join('、')}`);
      if (images.length > 0) parts.push(`読み込めなかった画像: ${images.join('、')}`);
      const e = new Error(parts.join(' / '));
      e.missingFonts = fonts;
      e.brokenImages = images;
      throw e;
    }
  }

  // ---- 見えている文字の一覧 ----
  const r2 = (x) => Math.round(x * 100) / 100;
  /** 文字ノードを「見えている」とする不透明度の下限（祖先まで掛け合わせた値。check.mjs と同じ 0.5） */
  const VISIBLE_OPACITY = 0.5;
  const union = (a, c) => (a ? { left: Math.min(a.left, c.left), top: Math.min(a.top, c.top), right: Math.max(a.right, c.right), bottom: Math.max(a.bottom, c.bottom) } : c);
  const toBox = (b) => ({ x: r2(b.left), y: r2(b.top), w: r2(b.right - b.left), h: r2(b.bottom - b.top) });
  /**
   * 要素または文字ノードの範囲が、画面の中で見えているなら箱を返す。
   * 要素なら、中の文字ノードごとに（その親の不透明度とマスクで）見えている部分を求めて合わせる。
   * 行や文節ごとの span をマスクの中から出すとき、まだ隠れている span を箱に入れないため。
   * box はマスクで切った箱（重なりの点検に使う）、full は見えている文字ノードの切る前の箱（画面の外へのはみ出しの点検に使う）。
   * cut は、見えている文字ノードのどれかが、マスクで一部隠れているか（小さな箱で切れたままの文字の点検に使う）。
   * data-ms-scroll の箱の中（流れる文字やクレジット）は、切れていてもよいので、full をマスクで切った箱にし、cut に数えない。
   * spill は、文字ノードの行の箱（マスクで切った後）が、いちばん近い背景つきの祖先の箱（paintBox）を越える幅の最大
   * （背景の箱からはみ出したままの文字の点検に使う）。比べる箱が無い文字や、data-ms-scroll の箱の中の文字は数えず、どれも無ければ null。
   * parts は、空白でない文字ノードごと（木の順）の cut と spill。透明（不透明度 0.5 未満）や非表示の文字ノードは null、
   * マスクで丸ごと隠れた文字ノードは cut: true。語や文節ごとの span を順に出す見出しでは、先に出た語だけが見えている時刻があるので、
   * 「切れずに全部見えた」かは文字ノードごとに数える（check.mjs）。data-ms-scroll の箱の中の文字ノードは cut: false、spill: null。
   * @typedef {{x: number, y: number, w: number, h: number}} Box
   * @typedef {{over: number, glyph: Box, paint: Box}} Spill
   * @returns {{box: Box, full: Box, cut: boolean, spill: Spill | null, parts: Array<{cut: boolean, spill: Spill | null} | null>} | null}
   */
  function visibleBox(node, el) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    const nodes = [];
    if (node.nodeType === Node.TEXT_NODE) nodes.push(node);
    else {
      const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.trim()) nodes.push(n);
    }
    let b = null, full = null, cut = false, spill = null;
    const parts = [];
    for (const n of nodes) {
      parts.push(null);
      const p = n.parentElement;
      if (!p || !p.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (opacityOf(p) < VISIBLE_OPACITY) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const raw = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      const c = clipToMasks(raw, p);
      const scroll = p.closest('[data-ms-scroll]');
      if (!c) {
        if (!scroll) parts[parts.length - 1] = { cut: true, spill: null };
        continue;
      }
      b = union(b, c);
      full = union(full, scroll ? c : raw);
      const part = { cut: false, spill: null };
      if (!scroll) {
        part.cut = lineCut(range, p);
        part.spill = spillOf(range, p);
        cut ||= part.cut;
        if (part.spill && (!spill || part.spill.over > spill.over)) spill = part.spill;
      }
      parts[parts.length - 1] = part;
    }
    if (!b || b.right - b.left <= 0 || b.bottom - b.top <= 0) return null;
    if (b.right <= 0 || b.bottom <= 0 || b.left >= innerWidth || b.top >= innerHeight) return null;
    return { box: toBox(b), full: toBox(full), cut, spill, parts };
  }
  /**
   * 文字ノードの行ごとの箱。行ごとの箱は、字面の上下の余白を含む（Noto Sans JP で約 1.45em）。
   * 行の高さ（line-height）がそれより小さいと、行の高さぴったりの箱でも余白がはみ出すので、行の高さの分（上下の中央）に縮める。
   * 行の高さが normal なら、字面の箱は字の大きさ（1em）より高く、字そのものは 1em に収まるので、1em（上下の中央）に縮める。
   */
  function lineBoxes(range, p) {
    const cs = getComputedStyle(p);
    const lh = cs.lineHeight === 'normal' ? parseFloat(cs.fontSize) : parseFloat(cs.lineHeight);
    const sy = p.offsetHeight ? p.getBoundingClientRect().height / p.offsetHeight : 1;
    const out = [];
    for (const r of range.getClientRects()) {
      if (r.width <= 0 || r.height <= 0) continue;
      const pad = lh > 0 && lh * sy < r.height ? (r.height - lh * sy) / 2 : 0;
      out.push({ left: r.left, top: r.top + pad, right: r.right, bottom: r.bottom - pad });
    }
    return out;
  }
  /** 文字ノードの行のどれかが、マスクで一部（または全部）隠れているか（行の箱は lineBoxes） */
  function lineCut(range, p) {
    for (const line of lineBoxes(range, p)) {
      const c = clipToMasks(line, p);
      if (!c || c.right - c.left < line.right - line.left - 1 || c.bottom - c.top < line.bottom - line.top - 1) return true;
    }
    return false;
  }
  /** 色が透明か（getComputedStyle の rgba(…, 0) か transparent） */
  const clear = (c) => c === 'transparent' || /,\s*0(\.0*)?\)$/.test(c);
  /** 要素が自分の箱を塗っているか（背景の色か画像、枠線、影）。visibility で隠した要素は塗らない */
  function painted(cs) {
    if (cs.visibility !== 'visible') return false;
    if (!clear(cs.backgroundColor) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none') return true;
    return ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(cs[`border${side}Width`]) > 0
      && !['none', 'hidden'].includes(cs[`border${side}Style`]) && !clear(cs[`border${side}Color`]));
  }
  /**
   * 文字の入れ物として見える箱: el 自身か祖先のうち、いちばん近い、箱を塗っている要素の枠線の内側。
   * html と body、画面全体を覆う箱（全面の背景）は数えない。飾りの形など、祖先でない要素も数えない。無ければ null。
   * clipToMasks と同じく、包含ブロックをたどった先の祖先だけ数える（位置を決めていない箱の中の absolute や fixed の文字は、
   * その箱の外に置かれうるので、その箱は入れ物ではない）。
   */
  function paintBox(el) {
    let pos = getComputedStyle(el).position;
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (e !== el) {
        if (!(pos === 'absolute' ? holdsAbsolute(cs) : pos === 'fixed' ? holdsFixed(cs) : true)) continue;
        pos = cs.position;
      }
      if (!painted(cs)) continue;
      const r = e.getBoundingClientRect();
      if (r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight) continue;
      const sx = e.offsetWidth ? r.width / e.offsetWidth : 1, sy = e.offsetHeight ? r.height / e.offsetHeight : 1;
      return {
        left: r.left + parseFloat(cs.borderLeftWidth) * sx, top: r.top + parseFloat(cs.borderTopWidth) * sy,
        right: r.right - parseFloat(cs.borderRightWidth) * sx, bottom: r.bottom - parseFloat(cs.borderBottomWidth) * sy,
      };
    }
    return null;
  }
  /**
   * 文字ノードの行の箱（マスクで切った後。まだ隠れている部分は数えない）が、paintBox を越える幅（px、4辺の最大。収まっていれば 0 以下）。
   * 比べる箱が無い、または全部隠れていれば null。
   */
  function spillOf(range, p) {
    const pb = paintBox(p);
    if (!pb) return null;
    let g = null;
    for (const line of lineBoxes(range, p)) {
      const c = clipToMasks(line, p);
      if (c && c.right > c.left && c.bottom > c.top) g = union(g, c);
    }
    if (!g) return null;
    const over = Math.max(pb.left - g.left, pb.top - g.top, g.right - pb.right, g.bottom - pb.bottom);
    return { over: r2(over), glyph: toBox(g), paint: toBox(pb) };
  }
  /** この要素が、absolute の子孫の包含ブロックになるか（位置を決めているか、変形などがあるか） */
  function holdsAbsolute(cs) {
    return cs.position !== 'static' || holdsFixed(cs);
  }
  /** この要素が、fixed の子孫の包含ブロックになるか */
  function holdsFixed(cs) {
    return cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none'
      || (cs.backdropFilter && cs.backdropFilter !== 'none')
      || /paint|layout|strict|content/.test(cs.contain || '')
      || /transform|perspective|filter/.test(cs.willChange || '');
  }
  /**
   * 文字の箱から、マスクで隠れた部分を除く。el は文字ノードの親。マスクは、el と祖先の overflow（visible 以外。
   * el 自身の overflow は省略記号 text-overflow: ellipsis などで中の文字を切る）と、el と祖先の clip-path: inset()。
   * マスクの中から文字を出す入場で、まだ隠れている部分を「重なり」に数えないため。
   * overflow は、包含ブロックをたどった先の祖先のものだけ数える（位置を決めていない箱の overflow は、
   * 中の absolute や fixed の文字を切らない）。clip-path は、どの祖先のものも中身を切る。
   * html と body の overflow は除く（画面の外へのはみ出しは、別の点検で見つける）。
   */
  function clipToMasks(box, el) {
    let b = box;
    const cut = (l, t, r, btm) => {
      b = { left: Math.max(b.left, l), top: Math.max(b.top, t), right: Math.min(b.right, r), bottom: Math.min(b.bottom, btm) };
    };
    // 包含ブロックをたどっている途中の、いちばん近い要素の position
    let pos = getComputedStyle(el).position;
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const rect = e.getBoundingClientRect();
      // el の文字は el の中身なので、el の overflow は位置によらず数える
      const inChain = e === el || (pos === 'absolute' ? holdsAbsolute(cs) : pos === 'fixed' ? holdsFixed(cs) : true);
      if (inChain) {
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') cut(rect.left, rect.top, rect.right, rect.bottom);
        pos = cs.position;
      }
      const m = /^inset\(([^)]*)\)$/.exec(cs.clipPath.trim());
      if (m) {
        // inset(上 右 下 左 [round …]) の長さを、要素の箱（変形の後の大きさ）に対して px にする
        const parts = m[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
        const [t, rt = t, bt = t, lf = rt] = parts;
        const sx = e.offsetWidth ? rect.width / e.offsetWidth : 1, sy = e.offsetHeight ? rect.height / e.offsetHeight : 1;
        const len = (v, size, scale) => (v.endsWith('%') ? (parseFloat(v) / 100) * size * scale : (parseFloat(v) || 0) * scale);
        cut(rect.left + len(lf, e.offsetWidth, sx), rect.top + len(t, e.offsetHeight, sy),
          rect.right - len(rt, e.offsetWidth, sx), rect.bottom - len(bt, e.offsetHeight, sy));
      }
      if (b.right - b.left <= 0 || b.bottom - b.top <= 0) return null;
    }
    return b;
  }
  /** 祖先まで掛け合わせた不透明度（color は不透明度を含まないので、別に返す） */
  function opacityOf(el) {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return Math.round(o * 1000) / 1000;
  }
  /** data-ms-intent の語（既定から外す演出として宣言した点検の名前）。空白で区切る */
  const intentWords = (e) => (e.getAttribute?.('data-ms-intent') ?? '').split(/\s+/).filter(Boolean);
  /** 要素と祖先の data-ms-intent の語を合わせたもの（祖先に付けた宣言は中の要素にも効く） */
  function intentOf(el) {
    const set = new Set();
    for (let e = el; e; e = e.parentElement) for (const w of intentWords(e)) set.add(w);
    return [...set];
  }
  /**
   * シーンの宣言。root は body（とその祖先）の語で、シーン全体に効く。all はページにあるすべての語（名前の確かめと記録に使う）
   * counts は、点検の名前ごとに、その語を書いた要素の数（確認ページに出す）
   * @returns {{root: string[], all: string[], counts: Record<string, number>}}
   */
  function intents() {
    const all = new Set();
    const counts = {};
    for (const e of document.querySelectorAll('[data-ms-intent]')) {
      for (const w of new Set(intentWords(e))) {
        all.add(w);
        counts[w] = (counts[w] ?? 0) + 1;
      }
    }
    return { root: document.body ? intentOf(document.body) : intentWords(document.documentElement), all: [...all], counts };
  }
  function entry(id, s, node, el) {
    const v = visibleBox(node, el);
    if (!v) return null;
    const cs = getComputedStyle(el);
    return { id, text: s, box: v.box, full: v.full, cut: v.cut, spill: v.spill, parts: v.parts, color: cs.color, fontSize: parseFloat(cs.fontSize), opacity: opacityOf(el), intent: intentOf(el) };
  }

  /** 直前の layout() が返した文字の要素（veils() が同じ順で使う） */
  let lastEls = [];

  /**
   * 直前の layout() の i 番目の文字の上に重なっている、半透明の面（背景色のある要素）を下から順に返す。
   * 操作箇所の外を暗くする面のように、文字の上に重ねた面は、文字の色も地の色も一緒に変える。
   * 自動点検のコントラストは、面を重ねた後の文字の色で比べる（地はスクリーンショットから測るので、すでに面が重なっている）。
   * 面は pointer-events: none のことが多いので、調べる間だけ当たり判定を戻す。
   * @param {number[]} indices
   * @returns {Array<Array<{rgb: number[], a: number}>>}
   */
  /** 色の名前を読む 1×1 の canvas（rgb() 以外の形の色を、ブラウザに rgb へ直させる） */
  let swatch = null;
  /**
   * CSS の色（getComputedStyle の値）を [r, g, b, a]（0〜255、a は 0〜1）に。rgb()・rgba() はそのまま読み、
   * oklch()・color()・color-mix() などは canvas に塗らせて読む。読めなければ null
   */
  function rgba(css) {
    if (!css || css === 'transparent') return null;
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(css);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])];
    swatch ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    swatch.clearRect(0, 0, 1, 1);
    swatch.fillStyle = 'rgba(0, 0, 0, 0)';
    swatch.fillStyle = css;
    if (swatch.fillStyle === 'rgba(0, 0, 0, 0)' && !/^rgba?\(/.test(css)) return null;
    swatch.fillRect(0, 0, 1, 1);
    const d = swatch.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }

  function veils(indices) {
    const st = document.createElement('style');
    st.textContent = '*{pointer-events:auto !important}';
    document.head.append(st);
    try {
      return indices.map((i) => {
        const it = lastEls[i];
        if (!it) return [];
        const { el, box } = it;
        const out = [];
        for (const e of document.elementsFromPoint(box.x + box.w / 2, box.y + box.h / 2)) {
          if (e === el || el.contains(e) || e.contains(el)) break;
          const cs = getComputedStyle(e);
          // 乗算などで重ねた面は、字を透かすので、隠す面としても色を変える面としても数えない（地の色はスクリーンショットで測る）
          if (cs.mixBlendMode !== 'normal') continue;
          const c = rgba(cs.backgroundColor);
          if (!c) continue;
          const a = c[3] * opacityOf(e);
          if (a > 0.001) out.push({ rgb: c.slice(0, 3), a });
        }
        return out.reverse();
      });
    } finally {
      st.remove();
    }
  }

  /** 文字の上に重なると文字を隠す、塗りのある要素か（covers() が数える形）。半透明（0.5 未満）の面はコントラストの点検に任せる */
  function hides(e) {
    if (e === document.body || e === document.documentElement) return false;
    if (e.closest('[data-ms-text], [data-ms-wipe]')) return false;
    if (opacityOf(e) < VISIBLE_OPACITY) return false;
    const cs = getComputedStyle(e);
    // 乗算・比較（暗）などで重ねた形（蛍光ペンの帯など）は、字が透けて読めるので数えない
    if (cs.mixBlendMode !== 'normal') return false;
    if (e instanceof SVGGeometryElement) return cs.fill !== 'none' || cs.stroke !== 'none';
    if (e instanceof SVGElement) return false;
    if (['IMG', 'CANVAS', 'VIDEO'].includes(e.tagName)) return true;
    if (cs.backgroundImage !== 'none') return true;
    return (rgba(cs.backgroundColor)?.[3] ?? 0) >= VISIBLE_OPACITY;
  }
  /** covers() が点を置く、行の箱の上下の中央の割合（字のある帯。上下の残りは行の余白と、字の上下の空き） */
  const INK_BAND = 0.7;
  /** 要素を短く示す（div#a.sh.circle） */
  const describe = (e) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + [...e.classList].slice(0, 3).map((c) => `.${c}`).join('');

  /**
   * 直前の layout() の i 番目の文字の上に、文字でない塗りのある要素（図形・面・画像。hides()）が重なっている割合。
   * 見えている文字ノードの行の箱（マスクで切った後）に格子状に点を置き、その点で文字の要素より上（手前）に描かれた要素を
   * elementsFromPoint で調べる。文字の要素（またはその中の要素）に当たらない点は数えない。
   * data-ms-text の中の要素（ほかの文字）と、data-ms-wipe を付けた要素（わざと文字の上を通す拭き取り）は数えない。
   * data-ms-scroll の箱の中の文字（流れる文字の窓の端にかける面など）は見ない（null）。
   * @param {number[]} indices
   * @returns {Array<{frac: number, by: string|null, byIntent: string[]} | null>} frac は隠れた点の割合（0〜1）、by はいちばん多く隠した要素、
   *   byIntent はその要素の data-ms-intent（祖先を含む）
   */
  function covers(indices) {
    const st = document.createElement('style');
    st.textContent = '*{pointer-events:auto !important}';
    document.head.append(st);
    try {
      return indices.map((i) => {
        const it = lastEls[i];
        if (!it || it.el.closest('[data-ms-scroll]')) return null;
        const { el } = it;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let total = 0, hit = 0;
        /** @type {Map<Element, number>} */
        const by = new Map();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const p = n.parentElement;
          if (!n.data.trim() || !p || opacityOf(p) < VISIBLE_OPACITY) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const line of lineBoxes(range, p)) {
            // 字の帯（行の箱の上下の中央 INK_BAND）だけを見る。行の上下の余白に引いた下線や帯は、字を隠さない
            const inset = ((line.bottom - line.top) * (1 - INK_BAND)) / 2;
            const c = clipToMasks({ ...line, top: line.top + inset, bottom: line.bottom - inset }, p);
            if (!c) continue;
            const w = c.right - c.left, h = c.bottom - c.top;
            const cols = Math.min(24, Math.max(2, Math.ceil(w / 24))), rows = Math.min(6, Math.max(2, Math.ceil(h / 24)));
            for (let a = 0; a < cols; a++) {
              for (let b = 0; b < rows; b++) {
                const x = c.left + ((a + 0.5) * w) / cols, y = c.top + ((b + 0.5) * h) / rows;
                if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
                const stack = document.elementsFromPoint(x, y);
                const k = stack.findIndex((e) => e === el || el.contains(e) || e.contains(el));
                // 文字の要素に当たらない点（祖先にだけ当たる）は、文字の外なので数えない
                if (k < 0 || (stack[k] !== el && !el.contains(stack[k]))) continue;
                total++;
                const top = stack.slice(0, k).find(hides);
                if (top) {
                  hit++;
                  by.set(top, (by.get(top) ?? 0) + 1);
                }
              }
            }
          }
        }
        if (!total) return null;
        const most = [...by].sort((a, b) => b[1] - a[1])[0];
        return { frac: Math.round((hit / total) * 1000) / 1000, by: most ? describe(most[0]) : null, byIntent: most ? intentOf(most[0]) : [] };
      });
    } finally {
      st.remove();
    }
  }

  /** 見えている全テキスト。data-ms-text の要素は要素ごとに1件、それ以外は文字ノードごとに1件（id: null） */
  function layout() {
    const out = [];
    lastEls = [];
    const done = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || SKIP.has(el.tagName) || !n.data.trim()) continue;
      const owner = el.closest('[data-ms-text]');
      let item;
      if (owner) {
        if (done.has(owner)) continue;
        done.add(owner);
        item = entry(owner.getAttribute('data-ms-text'), owner.textContent.trim(), owner, owner);
      } else {
        item = entry(null, n.data.trim().replace(/\s+/g, ' '), n, el);
      }
      if (item) {
        lastEls.push({ el: owner ?? el, box: item.box });
        out.push({ ...item, index: out.length });
      }
    }
    return out;
  }

  // ---- 公開 ----
  const ms = {
    /** シーンの描画関数を登録する。DOMContentLoaded の前でも後でもよい */
    scene(fn) {
      draw = fn;
      if (domReady) seek(now);
    },
    text,
    time,
    ease,
    spring,
    rand,
    ratio: init.ratio,
    width: init.width,
    height: init.height,
    /** シーンの長さ（秒） */
    duration: init.slice.scene.end - init.slice.scene.start,
  };
  window.ms = ms;
  window.__ms = { ready, seek, layout, veils, covers, intents };

  // 注入の時点ではまだ <html> が無いことが多いので、できた瞬間に付ける
  setupRoot();
  if (!rootDone) {
    const obs = new MutationObserver(() => {
      setupRoot();
      if (rootDone) obs.disconnect();
    });
    obs.observe(document, { childList: true });
  }
  domReadyP.then(() => {
    domReady = true;
    setupRoot();
    seek(now);
  });
})();
