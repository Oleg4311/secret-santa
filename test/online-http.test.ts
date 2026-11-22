// HTTP-тесты настоящего собранного Worker (worker/dist/index.mjs) в Miniflare: маршруты, CORS, ошибки, Durable Object с хранилищем.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { Miniflare } from 'miniflare';

const ORIGIN = 'https://oleg4311.github.io';
let mf: Miniflare;

before(async () => {
  execFileSync(process.execPath, ['scripts/build-worker.mjs'], { stdio: 'ignore' });
  mf = new Miniflare({
    workers: [
      {
        name: 'api',
        modules: true,
        scriptPath: 'worker/dist/index.mjs',
        durableObjects: { GAME: { className: 'GameDO', useSQLite: true } },
        bindings: { ALLOWED_ORIGINS: ORIGIN },
        compatibilityDate: '2026-08-01',
      },
    ],
  });
  await mf.ready;
});
after(async () => {
  await mf.dispose();
});

const BASE = 'http://localhost';
async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await mf.dispatchFetch(BASE + path, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { status: res.status, json, headers: res.headers, text };
}

const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');

async function newGame(names = ['Анна', 'Борис', 'Вера', 'Глеб']) {
  const r = await call('POST', '/api/games', { body: { participants: names, title: 'Тест' } });
  assert.equal(r.status, 201, r.text);
  return r.json as { gameId: string; organizerToken: string; invites: { name: string; token: string }[]; expiresAt: number };
}

test('здоровье и заголовки безопасности', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('CORS: разрешён только адрес страницы; preflight отвечает 204', async () => {
  const ok = await call('OPTIONS', '/api/games', { headers: { origin: ORIGIN } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(ok.headers.get('access-control-allow-headers') ?? '', /authorization/);
  const bad = await call('OPTIONS', '/api/games', { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const get = await call('GET', '/api/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(get.headers.get('access-control-allow-origin'), null);
  const post = await call('POST', '/api/games', { headers: { origin: ORIGIN }, body: { participants: ['а', 'б', 'в'] } });
  assert.equal(post.headers.get('access-control-allow-origin'), ORIGIN);
});

test('полный сценарий через HTTP', async () => {
  const g = await newGame();
  assert.match(g.gameId, /^[0-9a-f]{64}$/);
  const keys = g.invites.map(() => key());
  const base = `/api/games/${g.gameId}`;

  let st = await call('GET', `${base}/status`, { token: g.organizerToken });
  assert.equal(st.status, 200);
  assert.equal(st.json.claimed, 0);

  const early = await call('POST', `${base}/draw`, { token: g.organizerToken });
  assert.equal(early.status, 409);
  assert.equal(early.json.error, 'not_everyone_joined');

  for (let i = 0; i < g.invites.length; i++) {
    const r = await call('POST', `${base}/claim`, { body: { invite: g.invites[i]!.token, key: keys[i] } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.name, g.invites[i]!.name);
  }
  const again = await call('POST', `${base}/claim`, { body: { invite: g.invites[0]!.token, key: key() } });
  assert.equal(again.status, 410);
  assert.equal(again.json.error, 'invite_used');

  const drawn = await call('POST', `${base}/draw`, { token: g.organizerToken });
  assert.equal(drawn.status, 200, drawn.text);
  assert.ok(!drawn.text.includes('target'), 'ответ организатору без пар');

  st = await call('GET', `${base}/status`, { token: g.organizerToken });
  assert.equal(st.json.phase, 'drawn');
  assert.ok(!st.text.includes('target'));

  const mine = await Promise.all(keys.map((k) => call('GET', `${base}/me`, { token: k })));
  const targets = mine.map((m) => m.json.target as string);
  assert.equal(new Set(targets).size, 4);
  mine.forEach((m, i) => assert.notEqual(m.json.target, g.invites[i]!.name));

  // вопрос от первого к его подопечному, ответ, повторное чтение
  const giftee = g.invites.findIndex((x) => x.name === targets[0]);
  const q = await call('POST', `${base}/ask`, { token: keys[0], body: { text: 'Любимый цвет?' } });
  assert.equal(q.status, 200, q.text);
  const inbox = await call('GET', `${base}/me`, { token: keys[giftee] });
  assert.equal(inbox.json.inbox.length, 1);
  assert.ok(!('from' in inbox.json.inbox[0]));
  const ans = await call('POST', `${base}/answer`, { token: keys[giftee], body: { id: q.json.id, text: 'Синий' } });
  assert.equal(ans.status, 200, ans.text);
  const back = await call('GET', `${base}/me`, { token: keys[0] });
  assert.equal(back.json.thread[0].answer, 'Синий');

  // организатор не может читать /me, участник не может рисовать
  assert.equal((await call('GET', `${base}/me`, { token: g.organizerToken })).status, 404);
  assert.equal((await call('POST', `${base}/draw`, { token: keys[0] })).status, 404);

  // удаление организатором: после него всё недоступно
  assert.equal((await call('DELETE', base, { token: keys[0] })).status, 404);
  const del = await call('DELETE', base, { token: g.organizerToken });
  assert.equal(del.status, 200);
  assert.equal((await call('GET', `${base}/me`, { token: keys[0] })).status, 404);
  assert.equal((await call('GET', `${base}/status`, { token: g.organizerToken })).status, 404);
});

test('игры изолированы друг от друга', async () => {
  const a = await newGame();
  const b = await newGame();
  assert.notEqual(a.gameId, b.gameId);
  const r = await call('GET', `/api/games/${b.gameId}/status`, { token: a.organizerToken });
  assert.equal(r.status, 404);
});

test('ошибки маршрутизации и разбора тела', async () => {
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('GET', '/api/games/zzz/status')).status, 404);
  assert.equal((await call('GET', `/api/games/${'0'.repeat(64)}/status`)).status, 404);
  const g = await newGame();
  assert.equal((await call('GET', `/api/games/${g.gameId}/draw`)).status, 405);
  assert.equal((await call('POST', `/api/games/${g.gameId}/status`)).status, 405);
  assert.equal((await call('POST', '/api/games', { body: '{не json', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await call('POST', '/api/games', { body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  const big = await call('POST', '/api/games', { body: { participants: ['а', 'б', 'в'], pad: 'x'.repeat(9000) } });
  assert.equal(big.status, 413);
  const bad = await call('POST', '/api/games', { body: { participants: ['а'] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_request');
  const impossible = await call('POST', '/api/games', { body: { participants: ['а', 'б', 'в'], exclusions: [[0, 1], [0, 2]] } });
  assert.equal(impossible.status, 422);
});

test('токен в строке запроса не принимается, неверная схема игнорируется', async () => {
  const g = await newGame();
  const q = await call('GET', `/api/games/${g.gameId}/status?token=${g.organizerToken}`);
  assert.equal(q.status, 404);
  const wrong = await call('GET', `/api/games/${g.gameId}/status`, { headers: { authorization: `Basic ${g.organizerToken}` } });
  assert.equal(wrong.status, 404);
});

test('внутренние ошибки не раскрывают подробности', async () => {
  const g = await newGame();
  const r = await call('POST', `/api/games/${g.gameId}/claim`, { body: { invite: 5, key: {} } });
  assert.equal(r.status, 400);
  assert.ok(!/stack|at /.test(r.text));
});
