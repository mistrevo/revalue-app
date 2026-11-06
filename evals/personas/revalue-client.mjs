// RE:VALUE を、手元のサーバー（Development）でペルソナとして API から使うための小さな道具。
// 使い方は同じフォルダの README.md。Node.js 24 の fetch だけを使う。

export const BASE = process.env.REVALUE_URL ?? 'http://localhost:5080';
export const CONSENT_VERSION = '2026-11-06';

/** 偽のログイン。dev_user は英数字とハイフンで 64 文字まで。名前ごとに別の人として扱われる。 */
export async function login(devUser) {
  const res = await fetch(`${BASE}/.auth/login/google?dev_user=${encodeURIComponent(devUser)}`, { redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (res.status !== 302 || !setCookie) {
    throw new Error(`ログインできません（${res.status}）。サーバーが Development で動いているか確かめる`);
  }
  return new RevalueClient(devUser, setCookie.split(';')[0]);
}

export class RevalueClient {
  constructor(devUser, cookie) {
    this.devUser = devUser;
    this.cookie = cookie;
  }

  async request(method, path, body) {
    const headers = { Cookie: this.cookie };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = text; }
    }
    if (!res.ok) {
      const error = new Error(`${method} ${path}: ${res.status} ${text}`);
      error.status = res.status;
      error.body = json;
      throw error;
    }
    return json;
  }

  get(path) { return this.request('GET', path); }
  post(path, body = {}) { return this.request('POST', path, body); }
  put(path, body) { return this.request('PUT', path, body); }

  // 始める
  me() { return this.get('/api/me'); }
  consent() { return this.post('/api/consent', { version: CONSENT_VERSION }); }

  // 話す（02 discover）
  startEpisode() { return this.post('/api/episodes', {}); }
  episode(id) { return this.get(`/api/episodes/${id}`); }
  finishEpisode(id) { return this.post(`/api/episodes/${id}/finish`); }

  /**
   * 答えを送り、返事のストリーム（Server-Sent Events）を最後まで読む。
   * kind は 'free'（自由に書いた）か 'choice'（選択肢の文をそのまま送る）。返事は 5〜10 秒ほどかかる。
   */
  async send(episodeId, text, kind = 'free') {
    const started = Date.now();
    const res = await fetch(`${BASE}/api/episodes/${episodeId}/messages`, {
      method: 'POST',
      headers: { Cookie: this.cookie, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text, kind }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      const error = new Error(`送信に失敗: ${res.status} ${raw}`);
      error.status = res.status;
      throw error;
    }
    const events = parseSse(raw);
    return {
      reply: events.filter(e => e.event === 'delta').map(e => e.data.text).join(''),
      choices: events.find(e => e.event === 'choices')?.data.choices ?? [],
      notices: events.filter(e => e.event === 'notice').map(e => e.data),
      error: events.find(e => e.event === 'error')?.data ?? null,
      done: events.some(e => e.event === 'done'),
      events,
      ms: Date.now() - started,
    };
  }

  /** そのときの記録をまとめて取る。段階ごとに呼んでファイルに残す（再起動で消えるため）。 */
  async snapshot() {
    const episodes = await this.get('/api/episodes');
    const list = Array.isArray(episodes) ? episodes : (episodes?.episodes ?? []);
    const details = [];
    for (const e of list) details.push(await this.episode(e.id));
    return {
      devUser: this.devUser,
      at: new Date().toISOString(),
      episodes: details,
      abilities: await this.get('/api/abilities'),
      profile: await this.get('/api/profile'),
      options: await this.get('/api/options'),
      deepen: await this.get('/api/deepen'),
      report: await this.get('/api/report'),
    };
  }
}

/** Server-Sent Events の本文を { event, data } の並びにする。data は JSON なら読んだ値。 */
export function parseSse(raw) {
  return raw
    .split(/\r?\n\r?\n/)
    .filter(block => block.trim())
    .map(block => {
      let event = 'message';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      const joined = data.join('\n');
      try { return { event, data: JSON.parse(joined) }; } catch { return { event, data: joined }; }
    });
}
