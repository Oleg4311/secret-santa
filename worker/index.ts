// Cloudflare Worker + Durable Object (по одному объекту на игру). Вся логика в logic.ts, здесь маршрутизация, CORS, ограничения и хранение.

import { ApiError, answer, ask, checkRemove, claim, createGame, drawGame, me, status } from './logic.ts';
import type { Game } from './logic.ts';

export interface Env {
  GAME: DurableObjectNamespace;
  /** Через запятую: с каких адресов страницы разрешены запросы. */
  ALLOWED_ORIGINS: string;
}

const MAX_BODY = 8 * 1024;
const GAME_ID = /^[0-9a-f]{64}$/;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin');
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-max-age': '600' };
  }
  return { vary: 'Origin' };
}

function json(data: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function errorResponse(e: unknown, cors: Record<string, string>): Response {
  if (e instanceof ApiError) return json({ error: e.code, message: e.message }, e.status, cors);
  return json({ error: 'internal', message: 'Внутренняя ошибка.' }, 500, cors);
}

async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_BODY) throw new ApiError(413, 'too_large', 'Слишком большой запрос.');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, 'too_large', 'Слишком большой запрос.');
  if (text === '') return {};
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) throw new ApiError(415, 'bad_content_type', 'Нужен Content-Type: application/json.');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'bad_request', 'Неверный JSON.');
  }
}

const bearer = (req: Request): string | undefined => /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(req.headers.get('authorization') ?? '')?.[1];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env);
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === '/api/health') return json({ ok: true }, 200, cors);
      if (url.pathname === '/api/games' && req.method === 'POST') {
        const body = await readJson(req);
        const id = env.GAME.newUniqueId();
        const res = await env.GAME.get(id).fetch('https://game/init', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
        const data = (await res.json()) as Record<string, unknown>;
        return json(res.ok ? { gameId: id.toString(), ...data } : data, res.status, cors);
      }
      const m = /^\/api\/games\/([0-9a-f]{64})(?:\/([a-z]+))?$/.exec(url.pathname);
      if (!m || !GAME_ID.test(m[1]!)) return json({ error: 'not_found', message: 'Не найдено.' }, 404, cors);
      const action = m[2] ?? 'root';
      const allowed: Record<string, string> = { status: 'GET', claim: 'POST', draw: 'POST', me: 'GET', ask: 'POST', answer: 'POST', root: 'DELETE' };
      if (allowed[action] !== req.method) return json({ error: 'method_not_allowed', message: 'Метод не поддерживается.' }, 405, cors);
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      let id: DurableObjectId;
      try {
        id = env.GAME.idFromString(m[1]!);
      } catch {
        return json({ error: 'not_found', message: 'Не найдено: игра удалена, срок истёк или ссылка неверна.' }, 404, cors); // выдуманный идентификатор
      }
      const stub = env.GAME.get(id);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const token = bearer(req);
      if (token) headers['authorization'] = `Bearer ${token}`;
      const res = await stub.fetch(`https://game/${action}`, { method: req.method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return new Response(res.body, { status: res.status, headers: { ...JSON_HEADERS, ...cors } });
    } catch (e) {
      return errorResponse(e, cors);
    }
  },
};

/** Один объект на игру: хранит состояние, выполняет действия по одному, сам удаляет всё по истечении срока. */
export class GameDO {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  private async load(): Promise<Game> {
    const game = await this.ctx.storage.get<Game>('game');
    if (!game) throw new ApiError(404, 'not_found', 'Не найдено: игра удалена, срок истёк или ссылка неверна.');
    if (Date.now() > game.expiresAt) {
      await this.ctx.storage.deleteAll();
      throw new ApiError(404, 'not_found', 'Не найдено: игра удалена, срок истёк или ссылка неверна.');
    }
    return game;
  }

  async fetch(req: Request): Promise<Response> {
    const action = new URL(req.url).pathname.slice(1);
    try {
      const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
      const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
      const now = Date.now();
      if (action === 'init') {
        if (await this.ctx.storage.get('game')) throw new ApiError(409, 'exists', 'Игра уже создана.');
        const { game, organizerToken, invites } = await createGame(body, now);
        await this.ctx.storage.put('game', game);
        await this.ctx.storage.setAlarm(game.expiresAt);
        return json({ organizerToken, invites, expiresAt: game.expiresAt }, 201);
      }
      const game = await this.load();
      let out: unknown;
      let dirty = false;
      switch (action) {
        case 'status': out = await status(game, token); break;
        case 'claim': out = await claim(game, body['invite'], body['key']); dirty = true; break;
        case 'draw': out = await drawGame(game, token, now); dirty = true; break;
        case 'me': out = await me(game, token); dirty = true; break; // отметка «открыл» сохраняется
        case 'ask': out = await ask(game, token, body['text'], now); dirty = true; break;
        case 'answer': out = await answer(game, token, body['id'], body['text'], now); dirty = true; break;
        case 'root':
          await checkRemove(game, token);
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.deleteAll();
          return json({ deleted: true }, 200);
        default: throw new ApiError(404, 'not_found', 'Не найдено.');
      }
      if (dirty) await this.ctx.storage.put('game', game);
      return json(out, 200);
    } catch (e) {
      return errorResponse(e, {});
    }
  }

  /** Срок игры вышел: удаляются имена, пары и вопросы. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
