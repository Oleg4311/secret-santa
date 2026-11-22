// Клиент онлайн-режима. Маршруты в хеше (он не уходит на сервер): #/ создать, #/o/<игра>/<токен организатора>,
// #/j/<игра>/<приглашение> занять место, #/p/<игра>/<ключ> страница участника.

declare const API_URL: string;

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
/** Адрес API; переопределить через ?api= можно только на локальной машине (чужой сервер получил бы ваши ключи). */
const API = (LOCAL && new URLSearchParams(location.search).get('api')) || API_URL;

const app = document.getElementById('app')!;
const toastEl = document.getElementById('toast')!;

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  setTimeout(() => toastEl.classList.remove('on'), 2200);
}

type Attrs = Record<string, string | boolean | ((e: Event) => void)>;
function h(tag: string, attrs: Attrs = {}, ...kids: Array<Node | string | null>): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else el.setAttribute(k, v);
  }
  for (const kid of kids) if (kid !== null) el.append(kid);
  return el;
}

class ApiFail extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiFail(0, 'network', 'Нет связи с сервером. Проверьте интернет и повторите.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiFail(res.status, data.error ?? 'error', data.message ?? `Ошибка ${res.status}`);
  return data as T;
}

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* без хранилища работает по ссылке */
    }
  },
  del(k: string): void {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ничего */
    }
  },
};

const randomKey = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const here = (hash: string): string => location.origin + location.pathname + '#' + hash;

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано');
  } catch {
    toast('Не удалось скопировать: выделите и скопируйте вручную');
  }
}

function show(...nodes: Node[]): void {
  app.replaceChildren(...nodes);
}

function errorCard(e: unknown): HTMLElement {
  const msg = e instanceof Error ? e.message : String(e);
  return h('section', { class: 'card', role: 'alert' }, h('h2', {}, 'Не получилось'), h('p', {}, msg), h('p', {}, h('a', { href: '#/' }, 'На главную')));
}

function intervalGuard(): { set(fn: () => void, ms: number): void; stop(): void } {
  let t: number | undefined;
  return {
    set(fn, ms) {
      if (t !== undefined) clearInterval(t);
      t = window.setInterval(fn, ms);
    },
    stop() {
      if (t !== undefined) clearInterval(t);
      t = undefined;
    },
  };
}
const poll = intervalGuard();

// ---------- создание ----------

interface Created {
  gameId: string;
  organizerToken: string;
  invites: Array<{ name: string; token: string }>;
  expiresAt: number;
}

function parseExclusions(text: string, names: string[]): { pairs: number[][]; problems: string[] } {
  const problems: string[] = [];
  const pairs: number[][] = [];
  const idx = (n: string): number => names.findIndex((x) => x.toLowerCase() === n.trim().toLowerCase());
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split(/\s*[+/]\s*/);
    const a = parts.length === 2 ? idx(parts[0]!) : -1;
    const b = parts.length === 2 ? idx(parts[1]!) : -1;
    if (a < 0 || b < 0 || a === b) problems.push(`Не понял строку «${line}»: нужны два разных имени из списка через «+».`);
    else pairs.push([a, b]);
  }
  return { pairs, problems };
}

function viewCreate(): void {
  const names = h('textarea', { id: 'names', rows: '6', placeholder: 'Анна\nБорис\nВера' }) as HTMLTextAreaElement;
  const title = h('input', { id: 'title', maxlength: '80', placeholder: 'Тайный Санта' }) as HTMLInputElement;
  const budget = h('input', { id: 'budget', maxlength: '40', placeholder: 'до 1500 ₽' }) as HTMLInputElement;
  const ex = h('textarea', { id: 'ex', rows: '3', placeholder: 'Анна + Борис' }) as HTMLTextAreaElement;
  const problems = h('div', { class: 'problems', role: 'alert' });
  const go = h('button', { class: 'primary', type: 'submit' }, 'Создать игру') as HTMLButtonElement;
  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        problems.textContent = '';
        const list = names.value.split('\n').map((s) => s.trim()).filter(Boolean);
        const { pairs, problems: bad } = parseExclusions(ex.value, list);
        if (bad.length) {
          problems.textContent = bad.join(' ');
          return;
        }
        go.disabled = true;
        try {
          const r = await api<Created>('POST', '/api/games', undefined, { participants: list, title: title.value, budget: budget.value, exclusions: pairs });
          store.set(`ss:o:${r.gameId}`, r.organizerToken);
          viewCreated(r);
        } catch (err) {
          problems.textContent = err instanceof Error ? err.message : String(err);
          go.disabled = false;
        }
      },
    },
    h('h2', {}, 'Новая игра'),
    problems,
    h('label', { for: 'names' }, 'Участники: по одному имени на строке (от 3 до 30)'),
    names,
    h('div', { class: 'row2' }, h('div', {}, h('label', { for: 'title' }, 'Название'), title), h('div', {}, h('label', { for: 'budget' }, 'Бюджет'), budget)),
    h('label', { for: 'ex' }, 'Кто не дарит друг другу (необязательно): «Имя + Имя», по паре на строке'),
    ex,
    h('div', { class: 'actions' }, go),
  );
  show(form, h('p', { class: 'hint' }, 'После создания вы получите личную ссылку для каждого участника и ссылку организатора. Организатор не узнает, кто кому дарит.'));
}

function viewCreated(r: Created): void {
  const orgLink = here(`/o/${r.gameId}/${r.organizerToken}`);
  const items = r.invites.map((i) => {
    const link = here(`/j/${r.gameId}/${i.token}`);
    return h('li', {}, h('span', { class: 'nm' }, i.name), h('button', { type: 'button', onclick: () => void copy(link) }, 'Скопировать ссылку'));
  });
  show(
    h('section', { class: 'card' },
      h('h2', {}, 'Игра создана'),
      h('p', { class: 'warn' }, 'Эти ссылки показываются один раз. Отправьте каждому его ссылку лично: тот, кто откроет её первым, займёт место этого участника.'),
      h('ul', { class: 'links' }, ...items),
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'Ссылка организатора'),
      h('p', { class: 'hint' }, 'По ней видно, кто уже занял место, и можно провести жеребьёвку. Пар она не показывает. Сохранится и в этом браузере.'),
      h('div', { class: 'actions' }, h('a', { href: `#/o/${r.gameId}/${r.organizerToken}` }, 'Открыть'), h('button', { type: 'button', onclick: () => void copy(orgLink) }, 'Скопировать')),
    ),
  );
}

// ---------- организатор ----------

interface Status {
  title: string;
  phase: 'joining' | 'drawn';
  claimed: number;
  total: number;
  expiresAt: number;
  participants: Array<{ name: string; claimed: boolean; opened: boolean }>;
}

async function viewOrganizer(id: string, token: string): Promise<void> {
  store.set(`ss:o:${id}`, token);
  const render = async (): Promise<void> => {
    try {
      const st = await api<Status>('GET', `/api/games/${id}/status`, token);
      const rows = st.participants.map((p) =>
        h('li', {}, h('span', { class: 'nm' }, p.name), h('span', { class: p.opened ? 'seen' : 'badge' }, st.phase === 'drawn' ? (p.opened ? 'открыл(а) пару' : 'ещё не открыл(а)') : p.claimed ? 'место занято' : 'ждём'))
      );
      const draw = h('button', { class: 'primary', type: 'button', disabled: st.phase !== 'joining' || st.claimed < st.total, onclick: async () => {
        try {
          await api('POST', `/api/games/${id}/draw`, token);
          toast('Жеребьёвка проведена');
          await render();
        } catch (e) {
          toast(e instanceof Error ? e.message : 'Ошибка');
        }
      } }, st.phase === 'drawn' ? 'Жеребьёвка проведена' : st.claimed < st.total ? `Ждём участников: ${st.claimed} из ${st.total}` : 'Провести жеребьёвку');
      const del = h('button', { type: 'button', onclick: async () => {
        if (!confirm('Удалить игру вместе с парами и вопросами? Это нельзя отменить.')) return;
        try {
          await api('DELETE', `/api/games/${id}`, token);
          store.del(`ss:o:${id}`);
          poll.stop();
          show(h('section', { class: 'card' }, h('h2', {}, 'Игра удалена'), h('p', {}, h('a', { href: '#/' }, 'Создать новую'))));
        } catch (e) {
          toast(e instanceof Error ? e.message : 'Ошибка');
        }
      } }, 'Удалить игру');
      show(
        h('section', { class: 'card' }, h('h2', {}, st.title), h('p', { class: 'hint' }, `Игра удалится сама ${new Date(st.expiresAt).toLocaleDateString('ru-RU')}. Вы не видите, кто кому дарит.`), h('ul', { class: 'who' }, ...rows), h('div', { class: 'actions' }, draw, del)),
      );
    } catch (e) {
      poll.stop();
      show(errorCard(e));
    }
  };
  await render();
  poll.set(() => void render(), 15000);
}

// ---------- участник ----------

async function viewJoin(id: string, invite: string): Promise<void> {
  const saved = store.get(`ss:p:${id}`);
  if (saved) {
    location.replace(`#/p/${id}/${saved}`);
    return;
  }
  show(
    h('section', { class: 'card' },
      h('h2', {}, 'Вас пригласили в игру'),
      h('p', {}, 'Нажмите кнопку, чтобы занять своё место. Приглашение сработает один раз: на этом устройстве.'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'button', onclick: async () => {
        const key = randomKey();
        try {
          await api('POST', `/api/games/${id}/claim`, undefined, { invite, key });
          store.set(`ss:p:${id}`, key);
          location.replace(`#/p/${id}/${key}`);
        } catch (e) {
          show(errorCard(e));
        }
      } }, 'Занять место')),
    ),
  );
}

interface QA {
  id: string;
  text: string;
  askedAt: number;
  answer?: string;
}
interface Me {
  name: string;
  title: string;
  budget?: string;
  phase: 'joining' | 'drawn';
  expiresAt: number;
  target?: string;
  thread: QA[];
  inbox: QA[];
}

async function viewParticipant(id: string, key: string): Promise<void> {
  store.set(`ss:p:${id}`, key);
  let typing = false; // не перерисовываем страницу, пока человек пишет
  const render = async (): Promise<void> => {
    if (typing) return;
    try {
      const m = await api<Me>('GET', `/api/games/${id}/me`, key);
      const parts: Node[] = [];
      if (m.phase === 'joining') {
        parts.push(h('section', { class: 'card center' }, h('h2', {}, `${m.name}, вы в игре «${m.title}»`), h('p', {}, 'Жеребьёвка ещё не проведена. Вернитесь по этой же ссылке позже.')));
      } else {
        parts.push(h('section', { class: 'card center' }, h('p', { class: 'muted' }, `${m.name}, вы дарите подарок:`), h('div', { class: 'target' }, m.target ?? ''), m.budget ? h('p', { class: 'muted' }, `Бюджет: ${m.budget}`) : null));
        const ta = h('textarea', { id: 'q', rows: '2', maxlength: '280', placeholder: 'Например: какой размер перчаток?' }) as HTMLTextAreaElement;
        ta.addEventListener('input', () => (typing = ta.value.length > 0));
        parts.push(
          h('section', { class: 'card' },
            h('h2', {}, 'Анонимный вопрос подопечному'),
            h('p', { class: 'hint' }, `${m.target ?? 'Подопечный'} увидит вопрос, но не узнает, от кого он. Не больше 5 вопросов.`),
            ...m.thread.map((q) => h('div', { class: 'q' }, h('div', {}, q.text), h('div', { class: q.answer ? 'a' : 'muted' }, q.answer ? `Ответ: ${q.answer}` : 'Ответа пока нет'))),
            h('label', { for: 'q' }, 'Ваш вопрос'),
            ta,
            h('div', { class: 'actions' }, h('button', { type: 'button', onclick: async () => {
              try {
                await api('POST', `/api/games/${id}/ask`, key, { text: ta.value });
                typing = false;
                toast('Отправлено');
                await render();
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Ошибка');
              }
            } }, 'Спросить')),
          ),
        );
        if (m.inbox.length) {
          parts.push(
            h('section', { class: 'card' },
              h('h2', {}, 'Вопросы вам от тайного Санты'),
              ...m.inbox.map((q) => {
                const a = h('input', { maxlength: '280', 'aria-label': `Ответ на вопрос «${q.text}»`, value: q.answer ?? '' }) as HTMLInputElement;
                a.addEventListener('input', () => (typing = true));
                return h('div', { class: 'q' }, h('div', {}, q.text), a, h('div', { class: 'actions' }, h('button', { type: 'button', onclick: async () => {
                  try {
                    await api('POST', `/api/games/${id}/answer`, key, { id: q.id, text: a.value });
                    typing = false;
                    toast('Ответ отправлен');
                    await render();
                  } catch (e) {
                    toast(e instanceof Error ? e.message : 'Ошибка');
                  }
                } }, 'Ответить')));
              }),
            ),
          );
        }
      }
      parts.push(
        h('section', { class: 'card' },
          h('h2', {}, 'Ваша ссылка'),
          h('p', { class: 'hint' }, 'В этом браузере страница откроется сама. Для другого устройства скопируйте ссылку и никому её не показывайте: по ней видна ваша пара.'),
          h('button', { type: 'button', onclick: () => void copy(here(`/p/${id}/${key}`)) }, 'Скопировать мою ссылку'),
        ),
      );
      show(...parts);
    } catch (e) {
      poll.stop();
      show(errorCard(e));
    }
  };
  await render();
  poll.set(() => void render(), 20000);
}

// ---------- маршрутизация ----------

function route(): void {
  poll.stop();
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const [kind, id, secret] = parts;
  const okId = id && /^[0-9a-f]{64}$/.test(id);
  const okSecret = secret && /^[A-Za-z0-9_-]{16,128}$/.test(secret);
  if (kind === 'o' && okId && okSecret) void viewOrganizer(id!, secret!);
  else if (kind === 'j' && okId && okSecret) void viewJoin(id!, secret!);
  else if (kind === 'p' && okId && okSecret) void viewParticipant(id!, secret!);
  else if (!kind) viewCreate();
  else show(errorCard(new Error('Ссылка повреждена: скопируйте её целиком.')));
}

window.addEventListener('hashchange', route);
route();
