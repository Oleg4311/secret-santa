// Персональная ссылка участника: вся информация лежит во фрагменте URL (после #), на сервер он не отправляется.
// Ссылка НЕ шифруется: тот, у кого она есть, может прочитать, кому дарить. Поэтому её отправляют только самому участнику.

export interface Card {
  /** Название игры */
  title: string;
  /** Кто открывает ссылку */
  from: string;
  /** Кому он дарит */
  to: string;
  /** Пожелания получателя */
  wish?: string;
  budget?: string;
  date?: string;
}

const LIMITS = { name: 60, title: 80, wish: 500, short: 60 } as const;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function encodeCard(card: Card): string {
  const compact = { v: 1, t: card.title, f: card.from, o: card.to, w: card.wish || undefined, b: card.budget || undefined, d: card.date || undefined };
  return toBase64Url(new TextEncoder().encode(JSON.stringify(compact)));
}

export class CardError extends Error {}

export function decodeCard(token: string): Card {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(token)));
  } catch {
    throw new CardError('Ссылка повреждена: возможно, она скопирована не целиком.');
  }
  const o = data as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > max) throw new CardError('Ссылка повреждена или содержит недопустимые данные.');
    return v;
  };
  if (typeof o !== 'object' || o === null || o.v !== 1) throw new CardError('Эта ссылка создана другой версией приложения.');
  const from = str(o.f, LIMITS.name);
  const to = str(o.o, LIMITS.name);
  if (!from || !to) throw new CardError('Ссылка повреждена: нет имён.');
  const card: Card = { title: str(o.t, LIMITS.title) ?? 'Тайный Санта', from, to };
  const wish = str(o.w, LIMITS.wish);
  const budget = str(o.b, LIMITS.short);
  const date = str(o.d, LIMITS.short);
  if (wish) card.wish = wish;
  if (budget) card.budget = budget;
  if (date) card.date = date;
  return card; // необязательные поля, которых не было в ссылке, в объекте отсутствуют
}

const PREFIX = '#/r/';

export function cardUrl(base: string, card: Card): string {
  return `${base.split('#')[0]}${PREFIX}${encodeCard(card)}`;
}

/** Достаёт карточку из location.hash; null, если это не ссылка участника. */
export function parseHash(hash: string): Card | null {
  return hash.startsWith(PREFIX) ? decodeCard(hash.slice(PREFIX.length)) : null;
}

export const MAX_LENGTHS = LIMITS;
