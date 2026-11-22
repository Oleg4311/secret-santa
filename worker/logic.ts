// Логика онлайн-режима «слепой организатор». Чистые функции над состоянием игры: без Cloudflare, только Web Crypto.
// Модель доверия:
//  * организатор создаёт игру и получает приглашения (по одному на участника) и свой токен для статуса и удаления;
//  * участник открывает приглашение и «занимает» его своим секретным ключом (его создаёт браузер участника): приглашение сгорает;
//  * жеребьёвка идёт на сервере, когда заняты все приглашения; пары хранятся под хешами ключей участников;
//  * организатор не получает ни ключей, ни пар: его ответы их не содержат. Единственный путь подсмотреть: занять чужое приглашение раньше
//    самого участника. Участник тогда увидит, что его приглашение уже использовано.
//  * подопечный получает анонимные вопросы дарителя: в ответах сервера нет ни имени, ни номера дарителя.

import { allowedMatrix, draw, isValid, secureRng } from '../src/draw.ts';
import type { Rng } from '../src/draw.ts';

export const LIMITS = {
  participantsMin: 3,
  participantsMax: 30,
  name: 40,
  title: 80,
  short: 40,
  exclusions: 100,
  text: 280,
  questionsPerGiver: 5,
  ttlDays: 60,
  keyMin: 22,
  keyMax: 128,
} as const;

export interface Participant {
  name: string;
  /** SHA-256 приглашения; null после того, как участник занял место. */
  inviteHash: string | null;
  /** SHA-256 секретного ключа участника; null, пока место не занято. */
  keyHash: string | null;
  opened: boolean;
}

export interface Question {
  id: string;
  /** Индекс дарителя: наружу не отдаётся никогда. */
  from: number;
  to: number;
  text: string;
  askedAt: number;
  answer?: string;
  answeredAt?: number;
}

export interface Game {
  v: 1;
  title: string;
  budget?: string;
  date?: string;
  createdAt: number;
  expiresAt: number;
  organizerHash: string;
  participants: Participant[];
  exclusions: Array<[number, number]>;
  phase: 'joining' | 'drawn';
  giftee?: number[];
  drawnAt?: number;
  questions: Question[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = () => new ApiError(404, 'not_found', 'Не найдено: игра удалена, срок истёк или ссылка неверна.');

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Управляющие символы и разделители строк Юникода: в именах и сообщениях им не место. */
function hasControl(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 32 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

function cleanText(v: unknown, field: string, max: number, required = false): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ApiError(400, 'bad_request', `Поле «${field}» обязательно.`);
    return '';
  }
  if (typeof v !== 'string') throw new ApiError(400, 'bad_request', `Поле «${field}» должно быть строкой.`);
  const s = v.normalize('NFC').trim().replace(/[ \t]+/g, ' ');
  if (s.length === 0 && required) throw new ApiError(400, 'bad_request', `Поле «${field}» обязательно.`);
  if (s.length > max) throw new ApiError(400, 'bad_request', `Поле «${field}» длиннее ${max} знаков.`);
  if (hasControl(s)) throw new ApiError(400, 'bad_request', `В поле «${field}» есть управляющие символы.`);
  return s;
}

export interface CreateResult {
  game: Game;
  organizerToken: string;
  invites: Array<{ name: string; token: string }>;
}

/** Создаёт игру. Заранее проверяет, что жеребьёвка возможна, чтобы организатор не узнал об этом, когда все уже заняли места. */
export async function createGame(input: unknown, now: number, rng: Rng = secureRng()): Promise<CreateResult> {
  if (typeof input !== 'object' || input === null) throw new ApiError(400, 'bad_request', 'Ожидался JSON-объект.');
  const body = input as Record<string, unknown>;
  const title = cleanText(body['title'], 'title', LIMITS.title) || 'Тайный Санта';
  const budget = cleanText(body['budget'], 'budget', LIMITS.short);
  const date = cleanText(body['date'], 'date', LIMITS.short);
  const rawNames = body['participants'];
  if (!Array.isArray(rawNames)) throw new ApiError(400, 'bad_request', 'participants должен быть массивом имён.');
  if (rawNames.length < LIMITS.participantsMin || rawNames.length > LIMITS.participantsMax) {
    throw new ApiError(400, 'bad_request', `Участников должно быть от ${LIMITS.participantsMin} до ${LIMITS.participantsMax}.`);
  }
  const names = rawNames.map((n, i) => cleanText(n, `participants[${i}]`, LIMITS.name, true));
  const seen = new Set<string>();
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) throw new ApiError(400, 'bad_request', `Имя «${n}» повторяется: нужны разные имена.`);
    seen.add(k);
  }
  const rawEx = body['exclusions'] ?? [];
  if (!Array.isArray(rawEx) || rawEx.length > LIMITS.exclusions) throw new ApiError(400, 'bad_request', `Исключений не больше ${LIMITS.exclusions}.`);
  const exclusions: Array<[number, number]> = rawEx.map((p) => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((x) => Number.isInteger(x) && x >= 0 && x < names.length) || p[0] === p[1]) {
      throw new ApiError(400, 'bad_request', 'Исключение — пара разных номеров участников.');
    }
    return [p[0], p[1]];
  });
  const possible = draw(names, exclusions, rng);
  if (!possible.ok) throw new ApiError(422, 'draw_impossible', possible.reason);

  const organizerToken = randomToken();
  const invites = await Promise.all(names.map(async (name) => ({ name, token: randomToken() })));
  const participants: Participant[] = await Promise.all(invites.map(async (i) => ({ name: i.name, inviteHash: await sha256(i.token), keyHash: null, opened: false })));
  const game: Game = {
    v: 1,
    title,
    ...(budget ? { budget } : {}),
    ...(date ? { date } : {}),
    createdAt: now,
    expiresAt: now + LIMITS.ttlDays * 86_400_000,
    organizerHash: await sha256(organizerToken),
    participants,
    exclusions,
    phase: 'joining',
    questions: [],
  };
  return { game, organizerToken, invites };
}

async function requireOrganizer(game: Game, token: string | undefined): Promise<void> {
  if (!token || (await sha256(token)) !== game.organizerHash) throw notFound();
}

async function findByKey(game: Game, key: string | undefined): Promise<number> {
  if (!key || key.length < LIMITS.keyMin || key.length > LIMITS.keyMax) throw notFound();
  const h = await sha256(key);
  const i = game.participants.findIndex((p) => p.keyHash === h);
  if (i < 0) throw notFound();
  return i;
}

function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= LIMITS.keyMin && key.length <= LIMITS.keyMax && /^[A-Za-z0-9_-]+$/.test(key);
}

/** Участник занимает приглашение своим ключом. Приглашение сгорает. */
export async function claim(game: Game, invite: unknown, key: unknown): Promise<{ name: string; title: string; phase: Game['phase'] }> {
  if (typeof invite !== 'string' || !validKey(key)) throw new ApiError(400, 'bad_request', 'Нужны invite и key (не короче 22 знаков, только A-Z a-z 0-9 _ -).');
  if (game.phase !== 'joining') throw new ApiError(409, 'already_drawn', 'Жеребьёвка уже проведена: занять место нельзя.');
  const h = await sha256(invite);
  const i = game.participants.findIndex((p) => p.inviteHash === h);
  if (i < 0) throw new ApiError(410, 'invite_used', 'Это приглашение уже использовано или неверно. Если вы его ещё не открывали, сообщите организатору: возможно, им воспользовался кто-то другой.');
  const keyHash = await sha256(key);
  if (game.participants.some((p) => p.keyHash === keyHash)) throw new ApiError(409, 'key_taken', 'Этот ключ уже занят: создайте другой.');
  const p = game.participants[i]!;
  p.inviteHash = null;
  p.keyHash = keyHash;
  return { name: p.name, title: game.title, phase: game.phase };
}

export async function status(game: Game, organizerToken: string | undefined) {
  await requireOrganizer(game, organizerToken);
  return {
    title: game.title,
    phase: game.phase,
    expiresAt: game.expiresAt,
    claimed: game.participants.filter((p) => p.keyHash !== null).length,
    total: game.participants.length,
    participants: game.participants.map((p) => ({ name: p.name, claimed: p.keyHash !== null, opened: p.opened })),
  };
}

/** Жеребьёвка. Результат проверяется ещё раз перед сохранением. */
export async function drawGame(game: Game, organizerToken: string | undefined, now: number, rng: Rng = secureRng()): Promise<{ phase: 'drawn' }> {
  await requireOrganizer(game, organizerToken);
  if (game.phase !== 'joining') throw new ApiError(409, 'already_drawn', 'Жеребьёвка уже проведена.');
  const missing = game.participants.filter((p) => p.keyHash === null).map((p) => p.name);
  if (missing.length) throw new ApiError(409, 'not_everyone_joined', `Ещё не заняли места: ${missing.join(', ')}.`);
  const result = draw(game.participants.map((p) => p.name), game.exclusions, rng);
  if (!result.ok) throw new ApiError(422, 'draw_impossible', result.reason);
  if (!isValid(result.giftee, allowedMatrix(game.participants.length, game.exclusions))) throw new ApiError(500, 'internal', 'Результат жеребьёвки не прошёл проверку.');
  game.giftee = result.giftee;
  game.phase = 'drawn';
  game.drawnAt = now;
  return { phase: 'drawn' };
}

const publicQuestion = (q: Question) => ({ id: q.id, text: q.text, askedAt: q.askedAt, ...(q.answer !== undefined ? { answer: q.answer, answeredAt: q.answeredAt } : {}) });

/**
 * Страница участника. «thread» — вопросы, которые участник задал своему подопечному, «inbox» — вопросы ему от анонимного дарителя.
 * В inbox нет ни одного поля, по которому можно понять, кто спрашивает.
 */
export async function me(game: Game, key: string | undefined) {
  const i = await findByKey(game, key);
  const p = game.participants[i]!;
  if (game.phase === 'drawn') p.opened = true;
  const target = game.phase === 'drawn' && game.giftee ? game.participants[game.giftee[i]!]!.name : undefined;
  return {
    name: p.name,
    title: game.title,
    ...(game.budget ? { budget: game.budget } : {}),
    ...(game.date ? { date: game.date } : {}),
    phase: game.phase,
    expiresAt: game.expiresAt,
    ...(target !== undefined ? { target } : {}),
    thread: game.questions.filter((q) => q.from === i).map(publicQuestion),
    inbox: game.questions.filter((q) => q.to === i).map(publicQuestion),
  };
}

function cleanMessage(v: unknown): string {
  const s = cleanText(v, 'text', LIMITS.text, true);
  return s;
}

export async function ask(game: Game, key: string | undefined, text: unknown, now: number) {
  const i = await findByKey(game, key);
  if (game.phase !== 'drawn' || !game.giftee) throw new ApiError(409, 'not_drawn', 'Вопросы можно задавать после жеребьёвки.');
  const msg = cleanMessage(text);
  if (game.questions.filter((q) => q.from === i).length >= LIMITS.questionsPerGiver) {
    throw new ApiError(429, 'too_many_questions', `Можно задать не больше ${LIMITS.questionsPerGiver} вопросов.`);
  }
  const q: Question = { id: randomToken(8), from: i, to: game.giftee[i]!, text: msg, askedAt: now };
  game.questions.push(q);
  return publicQuestion(q);
}

export async function answer(game: Game, key: string | undefined, id: unknown, text: unknown, now: number) {
  const i = await findByKey(game, key);
  if (typeof id !== 'string') throw new ApiError(400, 'bad_request', 'Нужен id вопроса.');
  const q = game.questions.find((x) => x.id === id && x.to === i);
  if (!q) throw notFound();
  q.answer = cleanMessage(text);
  q.answeredAt = now;
  return publicQuestion(q);
}

export async function checkRemove(game: Game, organizerToken: string | undefined): Promise<void> {
  await requireOrganizer(game, organizerToken);
}
