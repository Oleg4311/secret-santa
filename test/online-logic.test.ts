import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/draw.ts';
import { ApiError, LIMITS, answer, ask, claim, createGame, drawGame, me, randomToken, sha256, status } from '../worker/logic.ts';
import type { Game } from '../worker/logic.ts';

const NOW = 1_800_000_000_000;
const NAMES = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дарья', 'Егор'];

async function rejects(p: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ApiError, `ожидался ApiError, получено ${String(e)}`);
    assert.equal(e.status, status, `${e.code}: ${e.message}`);
    if (code) assert.equal(e.code, code);
    return e;
  }
  assert.fail(`ожидалась ошибка ${status}`);
}

interface Setup {
  game: Game;
  organizer: string;
  keys: string[];
  invites: string[];
  names: string[];
}

/** Создаёт игру и занимает места всеми участниками. */
async function started(names = NAMES, exclusions: number[][] = [], seed = 1): Promise<Setup> {
  const { game, organizerToken, invites } = await createGame({ participants: names, exclusions }, NOW, mulberry32(seed));
  const keys: string[] = [];
  for (const inv of invites) {
    const key = randomToken(16);
    await claim(game, inv.token, key);
    keys.push(key);
  }
  return { game, organizer: organizerToken, keys, invites: invites.map((i) => i.token), names };
}

test('sha256: контрольный вектор и независимость от регистра ввода не предполагается', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(await sha256('abc'), await sha256('ABC'));
});

test('создание: проверка входа', async () => {
  const bad = async (input: unknown, re: RegExp) => {
    const e = await rejects(createGame(input, NOW), 400);
    assert.match(e.message, re);
  };
  await bad(null, /JSON-объект/);
  await bad({}, /массивом/);
  await bad({ participants: ['а', 'б'] }, /от 3 до 30/);
  await bad({ participants: Array.from({ length: 31 }, (_, i) => `Имя${i}`) }, /от 3 до 30/);
  await bad({ participants: ['а', 'б', 'А'] }, /повторяется/);
  await bad({ participants: ['а', 'б', ' '] }, /обязательно/);
  await bad({ participants: ['а', 'б', 5] }, /строкой/);
  await bad({ participants: ['а', 'б', 'в'.repeat(LIMITS.name + 1)] }, /длиннее/);
  await bad({ participants: ['а', 'б', 'в\u0007'] }, /управляющие/);
  await bad({ participants: ['а', 'б', 'в г'] }, /управляющие/);
  await bad({ participants: ['а', 'б', 'в'], title: 'т'.repeat(LIMITS.title + 1) }, /title/);
  await bad({ participants: ['а', 'б', 'в'], exclusions: [[0, 0]] }, /пара разных/);
  await bad({ participants: ['а', 'б', 'в'], exclusions: [[0, 7]] }, /пара разных/);
  await bad({ participants: ['а', 'б', 'в'], exclusions: [['0', '1']] }, /пара разных/);
  await bad({ participants: ['а', 'б', 'в'], exclusions: 'нет' }, /Исключений/);
  await bad({ participants: ['а', 'б', 'в'], exclusions: Array.from({ length: 101 }, () => [0, 1]) }, /Исключений/);
});

test('создание: невозможные исключения отвергаются сразу, с объяснением', async () => {
  const e = await rejects(createGame({ participants: ['а', 'б', 'в'], exclusions: [[0, 1], [0, 2]] }, NOW), 422, 'draw_impossible');
  assert.match(e.message, /«а»/);
});

test('создание: имена нормализуются, заголовок по умолчанию, токены разные и случайные', async () => {
  const a = await createGame({ participants: ['  Анна  ', 'Борис', 'Вера'], budget: ' 1000 ₽ ' }, NOW);
  assert.deepEqual(a.game.participants.map((p) => p.name), ['Анна', 'Борис', 'Вера']);
  assert.equal(a.game.title, 'Тайный Санта');
  assert.equal(a.game.budget, '1000 ₽');
  const b = await createGame({ participants: ['Анна', 'Борис', 'Вера'] }, NOW);
  const all = [a.organizerToken, ...a.invites.map((i) => i.token), b.organizerToken, ...b.invites.map((i) => i.token)];
  assert.equal(new Set(all).size, all.length, 'ни один токен не повторяется');
  assert.ok(all.every((t) => /^[A-Za-z0-9_-]{22}$/.test(t)));
  assert.equal(a.game.expiresAt, NOW + 60 * 86_400_000);
});

test('в сохранённом состоянии нет ни одного выданного секрета: только хеши', async () => {
  const s = await started();
  const stored = JSON.stringify(s.game);
  for (const secret of [s.organizer, ...s.keys, ...s.invites]) assert.ok(!stored.includes(secret), 'секрет не должен храниться открытым');
  assert.ok(stored.includes(await sha256(s.organizer)));
});

test('полный цикл: занять места, провести жеребьёвку, каждый видит ровно свою пару', async () => {
  const s = await started(NAMES, [[0, 1], [2, 3]]);
  const st = await status(s.game, s.organizer);
  assert.equal(st.claimed, 6);
  assert.equal(st.phase, 'joining');
  await drawGame(s.game, s.organizer, NOW, mulberry32(7));
  const targets: string[] = [];
  for (let i = 0; i < NAMES.length; i++) {
    const r = await me(s.game, s.keys[i]);
    assert.equal(r.name, NAMES[i]);
    assert.equal(r.phase, 'drawn');
    assert.ok(r.target && r.target !== r.name, 'не себе');
    targets.push(r.target);
  }
  assert.equal(new Set(targets).size, NAMES.length, 'каждый получает ровно от одного');
  assert.notEqual(targets[0], 'Борис');
  assert.notEqual(targets[1], 'Анна');
  assert.notEqual(targets[2], 'Глеб');
  assert.notEqual(targets[3], 'Вера');
});

test('случайные игры: условия жеребьёвки соблюдены, организатор не получает никаких пар', async () => {
  for (let seed = 1; seed <= 150; seed++) {
    const n = 3 + (seed % 9);
    const names = Array.from({ length: n }, (_, i) => `Уч${seed}_${i}`);
    const rnd = mulberry32(seed);
    const ex: number[][] = [];
    for (let k = 0; k < n; k++) if (rnd() < 0.5) ex.push([Math.floor(rnd() * n), Math.floor(rnd() * n)].filter((v, i, a) => a.indexOf(v) === i) as number[]);
    const exclusions = ex.filter((p) => p.length === 2);
    let s: Setup;
    try {
      s = await started(names, exclusions, seed);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'draw_impossible') continue; // невозможные наборы отсекаются при создании
      throw e;
    }
    await drawGame(s.game, s.organizer, NOW, mulberry32(seed + 1000));
    const mine: string[] = [];
    for (let i = 0; i < n; i++) mine.push((await me(s.game, s.keys[i])).target as string);
    assert.equal(new Set(mine).size, n, `seed ${seed}`);
    names.forEach((name, i) => {
      assert.notEqual(mine[i], name);
      for (const [a, b] of exclusions) {
        if (i === a) assert.notEqual(mine[i], names[b]);
        if (i === b) assert.notEqual(mine[i], names[a]);
      }
    });
    // ответ организатору: только имена и флаги
    const st = JSON.stringify(await status(s.game, s.organizer));
    for (const bad of ['target', 'giftee', 'key', 'hash', '"to"', '"from"']) assert.ok(!st.includes(bad), `статус содержит ${bad}`);
    assert.deepEqual(Object.keys(JSON.parse(st).participants[0]).sort(), ['claimed', 'name', 'opened']);
  }
});

test('организатор и приглашения не открывают чужие пары: токен организатора и приглашение не годятся как ключ участника', async () => {
  const s = await started();
  await drawGame(s.game, s.organizer, NOW);
  await rejects(me(s.game, s.organizer), 404);
  for (const inv of s.invites) await rejects(me(s.game, inv), 404);
  await rejects(me(s.game, undefined), 404);
  await rejects(me(s.game, 'a'.repeat(21)), 404);
  await rejects(me(s.game, randomToken(16)), 404);
  await rejects(status(s.game, s.keys[0]), 404, 'not_found');
  await rejects(status(s.game, undefined), 404);
  await rejects(drawGame(s.game, s.keys[0], NOW), 404);
});

test('занятие места: приглашение сгорает, ключ чужой не подходит, после жеребьёвки занять нельзя', async () => {
  const { game, invites } = await createGame({ participants: NAMES }, NOW);
  const key = randomToken(16);
  const r = await claim(game, invites[0]!.token, key);
  assert.equal(r.name, 'Анна');
  await rejects(claim(game, invites[0]!.token, randomToken(16)), 410, 'invite_used');
  await rejects(claim(game, invites[1]!.token, key), 409, 'key_taken');
  await rejects(claim(game, 'неверное', randomToken(16)), 410);
  await rejects(claim(game, invites[1]!.token, 'коротко'), 400);
  await rejects(claim(game, invites[1]!.token, 'a'.repeat(21)), 400);
  await rejects(claim(game, invites[1]!.token, 'a'.repeat(129)), 400);
  await rejects(claim(game, invites[1]!.token, 'ключ-с-кириллицей-и-пробелами!!'), 400);
  await rejects(claim(game, 5, randomToken(16)), 400);
});

test('жеребьёвка: нельзя раньше времени, дважды и не организатору', async () => {
  const { game, organizerToken, invites } = await createGame({ participants: NAMES }, NOW);
  await claim(game, invites[0]!.token, randomToken(16));
  const e = await rejects(drawGame(game, organizerToken, NOW), 409, 'not_everyone_joined');
  assert.match(e.message, /Борис.*Егор/);
  for (const i of invites.slice(1)) await claim(game, i.token, randomToken(16));
  await drawGame(game, organizerToken, NOW);
  await rejects(drawGame(game, organizerToken, NOW), 409, 'already_drawn');
  await rejects(claim(game, invites[0]!.token, randomToken(16)), 409, 'already_drawn');
});

test('страница участника до жеребьёвки не содержит пары', async () => {
  const s = await started();
  const r = await me(s.game, s.keys[0]);
  assert.equal(r.phase, 'joining');
  assert.equal('target' in r, false);
  assert.deepEqual(r.thread, []);
});

test('отметка «открыл» появляется только после жеребьёвки и только у открывшего', async () => {
  const s = await started();
  await me(s.game, s.keys[0]);
  assert.equal((await status(s.game, s.organizer)).participants.some((p) => p.opened), false);
  await drawGame(s.game, s.organizer, NOW);
  await me(s.game, s.keys[2]);
  assert.deepEqual((await status(s.game, s.organizer)).participants.map((p) => p.opened), [false, false, true, false, false, false]);
});

test('анонимные вопросы: подопечный получает вопрос без каких-либо следов дарителя, даритель видит ответ', async () => {
  const names = ['Анна_уникальная', 'Борис_уникальный', 'Вера_уникальная', 'Глеб_уникальный'];
  const s = await started(names);
  await drawGame(s.game, s.organizer, NOW, mulberry32(3));
  const giver = 0;
  const giftee = names.indexOf((await me(s.game, s.keys[giver])).target as string);
  const q = await ask(s.game, s.keys[giver], 'Какой размер перчаток?', NOW + 1);
  assert.deepEqual(Object.keys(q).sort(), ['askedAt', 'id', 'text']);

  const inbox = await me(s.game, s.keys[giftee]);
  assert.equal(inbox.inbox.length, 1);
  assert.equal(inbox.inbox[0]!.text, 'Какой размер перчаток?');
  const json = JSON.stringify(inbox);
  const ownTarget = inbox.target as string;
  for (const n of names) if (n !== names[giftee] && n !== ownTarget) assert.ok(!json.includes(n), `у подопечного нет имени «${n}»`);
  assert.deepEqual(Object.keys(inbox.inbox[0]!).sort(), ['askedAt', 'id', 'text']);
  assert.ok(!inbox.thread.length, 'подопечный не видит чужих вопросов в «thread»');

  // даритель видит только имя подопечного (так задумано), но не подопечный дарителя
  const sent = await me(s.game, s.keys[giver]);
  assert.equal(sent.thread.length, 1);
  assert.equal(sent.inbox.length, 0);

  const ans = await answer(s.game, s.keys[giftee], q.id, 'M', NOW + 2);
  assert.equal(ans.answer, 'M');
  assert.equal((await me(s.game, s.keys[giver])).thread[0]!.answer, 'M');
  assert.equal((await me(s.game, s.keys[giftee])).inbox[0]!.answer, 'M');
  const after = JSON.stringify(await me(s.game, s.keys[giftee]));
  for (const n of names) if (n !== names[giftee] && n !== ownTarget) assert.ok(!after.includes(n));
});

test('вопросы: ограничения и права', async () => {
  const s = await started();
  await rejects(ask(s.game, s.keys[0], 'Рано?', NOW), 409, 'not_drawn');
  await drawGame(s.game, s.organizer, NOW);
  await rejects(ask(s.game, s.keys[0], '', NOW), 400);
  await rejects(ask(s.game, s.keys[0], 'я'.repeat(LIMITS.text + 1), NOW), 400);
  await rejects(ask(s.game, s.keys[0], 'с\u0000нулём', NOW), 400);
  await rejects(ask(s.game, s.keys[0], 5, NOW), 400);
  await rejects(ask(s.game, s.organizer, 'Организатор?', NOW), 404);
  const ids: string[] = [];
  for (let i = 0; i < LIMITS.questionsPerGiver; i++) ids.push((await ask(s.game, s.keys[0], `Вопрос ${i}`, NOW)).id);
  await rejects(ask(s.game, s.keys[0], 'Лишний', NOW), 429, 'too_many_questions');
  // отвечать может только адресат
  const giftee = s.names.indexOf((await me(s.game, s.keys[0])).target as string);
  const stranger = s.names.findIndex((_, i) => i !== giftee && i !== 0);
  await rejects(answer(s.game, s.keys[stranger], ids[0], 'я не адресат', NOW), 404);
  await rejects(answer(s.game, s.keys[0], ids[0], 'сам себе', NOW), 404);
  await rejects(answer(s.game, s.keys[giftee], 'нет-такого', 'x', NOW), 404);
  await rejects(answer(s.game, s.keys[giftee], 7, 'x', NOW), 400);
  await rejects(answer(s.game, s.keys[giftee], ids[0], '', NOW), 400);
  assert.equal((await answer(s.game, s.keys[giftee], ids[0], 'Можно', NOW)).answer, 'Можно');
});

test('чужой вопрос и чужой ответ не попадают в страницу третьего участника', async () => {
  const s = await started();
  await drawGame(s.game, s.organizer, NOW);
  const q = await ask(s.game, s.keys[1], 'Секретный вопрос', NOW);
  const giftee = s.names.indexOf((await me(s.game, s.keys[1])).target as string);
  await answer(s.game, s.keys[giftee], q.id, 'Секретный ответ', NOW);
  for (let i = 0; i < s.names.length; i++) {
    if (i === 1 || i === giftee) continue;
    const j = JSON.stringify(await me(s.game, s.keys[i]));
    assert.ok(!j.includes('Секретный'), `участник ${i} видит чужую переписку`);
  }
});
