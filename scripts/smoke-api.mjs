// Дымовая проверка работающего API: полный круг от создания игры до удаления. Использование: node scripts/smoke-api.mjs https://адрес [https://origin-страницы]
const [base, origin] = [process.argv[2]?.replace(/\/+$/, ''), process.argv[3]];
if (!base) throw new Error('Нужен адрес API первым аргументом');
const fail = (m) => {
  console.error('ОШИБКА: ' + m);
  process.exit(1);
};
const call = async (method, path, token, body, headers = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, json: await res.json().catch(() => ({})) };
};
const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');

const health = await call('GET', '/api/health');
if (health.res.status !== 200) fail(`health ${health.res.status}`);
if (origin) {
  const pre = await fetch(base + '/api/games', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
  if (pre.headers.get('access-control-allow-origin') !== origin) fail('CORS не разрешает адрес страницы ' + origin);
  const evil = await fetch(base + '/api/health', { headers: { origin: 'https://evil.example' } });
  if (evil.headers.get('access-control-allow-origin')) fail('CORS разрешает чужой адрес');
}
const g = await call('POST', '/api/games', undefined, { participants: ['Проверка-1', 'Проверка-2', 'Проверка-3'], title: 'smoke' });
if (g.res.status !== 201) fail(`создание ${g.res.status} ${JSON.stringify(g.json)}`);
const { gameId, organizerToken, invites } = g.json;
const p = `/api/games/${gameId}`;
const keys = invites.map(key);
try {
  for (let i = 0; i < 3; i++) if ((await call('POST', `${p}/claim`, undefined, { invite: invites[i].token, key: keys[i] })).res.status !== 200) fail('claim');
  if ((await call('POST', `${p}/claim`, undefined, { invite: invites[0].token, key: key() })).res.status !== 410) fail('повторное приглашение должно давать 410');
  if ((await call('POST', `${p}/draw`, organizerToken)).res.status !== 200) fail('draw');
  const targets = [];
  for (const k of keys) targets.push((await call('GET', `${p}/me`, k)).json.target);
  if (new Set(targets).size !== 3) fail('пары не образуют перестановку: ' + targets.join());
  const st = await call('GET', `${p}/status`, organizerToken);
  if (JSON.stringify(st.json).includes('target')) fail('организатору видны пары');
  console.log('API работает: круг игры пройден, пары корректны, организатору они не видны');
} finally {
  const del = await call('DELETE', p, organizerToken);
  if (del.res.status !== 200) console.error('не удалось удалить тестовую игру', del.res.status);
}
