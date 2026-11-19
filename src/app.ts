// Интерфейс «Тайного Санты». Состояние живёт в памяти, настройки игры сохраняются в localStorage.
// Принцип приватности: цель подарка попадает в DOM только после явного нажатия «Узнать» и удаляется кнопкой «Скрыть».
import { draw, secureRng } from './draw.ts';
import { CardError, MAX_LENGTHS, cardUrl, parseHash, type Card } from './link.ts';

interface Row {
  name: string;
  wish: string;
}
interface Setup {
  title: string;
  date: string;
  budget: string;
  people: Row[];
  pairs: Array<[string, string]>;
  mode: 'links' | 'device';
  /** Показывать ли поля пожеланий к подаркам */
  wishes: boolean;
}
interface Result {
  names: string[];
  wishes: string[];
  giftee: number[];
  title: string;
  date: string;
  budget: string;
  mode: 'links' | 'device';
  seen: Set<number>;
  open: number | null; // режим одного устройства: чьё имя сейчас раскрыто
}

const STORE = 'santa:setup:v1';
const SAMPLE = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дарья', 'Егор'];

const $app = document.getElementById('app') as HTMLElement;
const $toast = document.getElementById('toast') as HTMLElement;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function defaults(): Setup {
  return { title: 'Тайный Санта 2026', date: '', budget: '', people: [{ name: '', wish: '' }, { name: '', wish: '' }, { name: '', wish: '' }], pairs: [], mode: 'links', wishes: false };
}

function load(): Setup {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const s = JSON.parse(raw) as Setup;
      if (Array.isArray(s.people) && s.people.length > 0) return { ...defaults(), ...s };
    }
  } catch {
    /* хранилище недоступно или повреждено: начинаем с чистого листа */
  }
  return defaults();
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(setup));
  } catch {
    /* приватный режим: работаем без сохранения */
  }
}

let setup: Setup = load();
let result: Result | null = null;
let problems: string[] = [];

const names = () => setup.people.map((p) => p.name.trim()).filter(Boolean);

function toast(msg: string) {
  $toast.textContent = msg;
  $toast.classList.add('on');
  setTimeout(() => $toast.classList.remove('on'), 1800);
}

async function copy(text: string, ok = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(ok);
}

function focusHeading() {
  const h = $app.querySelector<HTMLElement>('h2');
  if (h) {
    h.tabIndex = -1;
    h.focus({ preventScroll: false });
  }
}

// ---------- Настройка игры ----------

function pairsHtml(): string {
  const have = new Set(names());
  const items = setup.pairs
    .map(([a, b], i) => ({ a, b, i }))
    .filter(({ a, b }) => have.has(a) && have.has(b))
    .map(
      ({ a, b, i }) =>
        `<li class="chip"><span>${esc(a)} и ${esc(b)}</span><button type="button" data-action="rmpair" data-i="${i}" aria-label="Убрать исключение ${esc(a)} и ${esc(b)}">✕</button></li>`,
    );
  return items.join('');
}

function optionsHtml(selected?: string): string {
  return names()
    .map((n) => `<option value="${esc(n)}"${n === selected ? ' selected' : ''}>${esc(n)}</option>`)
    .join('');
}

function personRow(p: Row, i: number): string {
  return `<li class="person">
    <input class="name" data-i="${i}" value="${esc(p.name)}" maxlength="${MAX_LENGTHS.name}" placeholder="Имя участника ${i + 1}" aria-label="Имя участника ${i + 1}" autocomplete="off" enterkeyhint="next">
    <button type="button" class="rm" data-action="remove" data-i="${i}" aria-label="Удалить участника ${i + 1}">✕</button>
    ${
      setup.wishes
        ? `<input class="wish" data-i="${i}" value="${esc(p.wish)}" maxlength="${MAX_LENGTHS.wish}" placeholder="Пожелания (необязательно)" aria-label="Пожелания участника ${i + 1}, необязательно" autocomplete="off">`
        : ''
    }
  </li>`;
}

function renderSetup() {
  $app.innerHTML = `
  <section class="card" aria-labelledby="how"><h2 id="how">Как это работает</h2>
    <ol>
      <li>Впишите участников (минимум трое) и пары, которые не должны дарить друг другу.</li>
      <li>Проведите жеребьёвку: приложение само решит, кто кому дарит.</li>
      <li>Разошлите личные ссылки или передавайте телефон по кругу. Каждый узнаёт только свою пару.</li>
    </ol>
  </section>
  <form id="setup" novalidate>
    <section class="card" aria-labelledby="g"><h2 id="g">Игра</h2>
      <label for="title">Название</label>
      <input id="title" value="${esc(setup.title)}" maxlength="${MAX_LENGTHS.title}" autocomplete="off">
      <div class="row2">
        <div><label for="date">Когда обмениваетесь</label><input id="date" value="${esc(setup.date)}" maxlength="${MAX_LENGTHS.short}" placeholder="например, 25 декабря" autocomplete="off"></div>
        <div><label for="budget">Бюджет</label><input id="budget" value="${esc(setup.budget)}" maxlength="${MAX_LENGTHS.short}" placeholder="например, до 1500 ₽" autocomplete="off"></div>
      </div>
    </section>
    <section class="card" aria-labelledby="p"><h2 id="p">Участники</h2>
      <ul class="people" id="people">${setup.people.map(personRow).join('')}</ul>
      <label class="radio" style="margin-bottom:10px"><input type="checkbox" id="wishes"${setup.wishes ? ' checked' : ''}><span>Собирать пожелания к подаркам<small>Пожелание получателя увидит его даритель.</small></span></label>
      <div class="actions">
        <button type="button" data-action="add">Добавить участника</button>
        <button type="button" data-action="sample">Заполнить примером</button>
      </div>
    </section>
    <section class="card" aria-labelledby="x"><h2 id="x">Кто не дарит друг другу</h2>
      <p class="hint">Например, пары или близкие родственники. Исключение действует в обе стороны.</p>
      <div class="pairform">
        <div><label for="pa">Первый</label><select id="pa">${optionsHtml()}</select></div>
        <div><label for="pb">Второй</label><select id="pb">${optionsHtml(names()[1])}</select></div>
        <button type="button" data-action="addpair">Добавить исключение</button>
      </div>
      <ul class="pairs" id="pairs" aria-label="Добавленные исключения">${pairsHtml()}</ul>
    </section>
    <section class="card" aria-labelledby="m"><h2 id="m">Как раздавать пары</h2>
      <div class="radios" role="radiogroup" aria-labelledby="m">
        <label class="radio"><input type="radio" name="mode" value="links"${setup.mode === 'links' ? ' checked' : ''}><span>Личные ссылки<small>Каждому отправляете его ссылку. Подходит, если вы не вместе.</small></span></label>
        <label class="radio"><input type="radio" name="mode" value="device"${setup.mode === 'device' ? ' checked' : ''}><span>По кругу на одном устройстве<small>Каждый по очереди смотрит свою пару. Даже организатор не узнаёт чужие.</small></span></label>
      </div>
    </section>
    <div id="problems" class="problems" role="alert" tabindex="-1">${problemsHtml()}</div>
    <button class="primary" type="submit" data-testid="go">Провести жеребьёвку</button>
  </form>`;
}

function problemsHtml(): string {
  if (problems.length === 0) return '';
  return problems.length === 1 ? esc(problems[0]) : `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
}

function showProblems(list: string[]) {
  problems = list;
  const el = document.getElementById('problems');
  if (el) {
    el.innerHTML = problemsHtml();
    if (list.length) el.focus();
  }
}

function refreshPairs() {
  const pa = document.getElementById('pa') as HTMLSelectElement | null;
  const pb = document.getElementById('pb') as HTMLSelectElement | null;
  const pairs = document.getElementById('pairs');
  if (!pa || !pb || !pairs) return;
  const [va, vb] = [pa.value, pb.value];
  pa.innerHTML = optionsHtml(va);
  pb.innerHTML = optionsHtml(vb);
  pairs.innerHTML = pairsHtml();
}

function startDraw() {
  const list = names();
  const bad: string[] = [];
  if (list.length < 3) bad.push('Добавьте минимум трёх участников: с двумя играть нет смысла.');
  const seen = new Map<string, number>();
  for (const n of list) seen.set(n.toLowerCase(), (seen.get(n.toLowerCase()) ?? 0) + 1);
  for (const [n, c] of seen) if (c > 1) bad.push(`Имена должны различаться: «${list.find((x) => x.toLowerCase() === n)}» повторяется. Добавьте фамилию или букву.`);
  if (bad.length) return showProblems(bad);

  const rows = setup.people.filter((p) => p.name.trim());
  const index = new Map(rows.map((p, i) => [p.name.trim(), i]));
  const pairs: Array<[number, number]> = [];
  for (const [a, b] of setup.pairs) {
    const i = index.get(a);
    const j = index.get(b);
    if (i !== undefined && j !== undefined) pairs.push([i, j]);
  }
  const r = draw(rows.map((p) => p.name.trim()), pairs, secureRng());
  if (!r.ok) return showProblems([r.reason]);

  problems = [];
  result = {
    names: rows.map((p) => p.name.trim()),
    wishes: rows.map((p) => (setup.wishes ? p.wish.trim() : '')),
    giftee: r.giftee,
    title: setup.title.trim() || 'Тайный Санта',
    date: setup.date.trim(),
    budget: setup.budget.trim(),
    mode: setup.mode,
    seen: new Set(),
    open: null,
  };
  render();
}

// ---------- Результаты ----------

function cardFor(r: Result, i: number): Card {
  const j = r.giftee[i];
  const card: Card = { title: r.title, from: r.names[i], to: r.names[j] };
  if (r.wishes[j]) card.wish = r.wishes[j];
  if (r.budget) card.budget = r.budget;
  if (r.date) card.date = r.date;
  return card;
}

const baseUrl = () => location.href.split('#')[0];

function linkText(r: Result, i: number): string {
  return `${r.names[i]}: ${cardUrl(baseUrl(), cardFor(r, i))}`;
}

function infoLines(c: { budget?: string; date?: string }): string {
  const parts = [c.budget ? `Бюджет: ${esc(c.budget)}` : '', c.date ? `Обмен подарками: ${esc(c.date)}` : ''].filter(Boolean);
  return parts.length ? `<p class="muted">${parts.join(' · ')}</p>` : '';
}

function renderResult() {
  const r = result!;
  if (r.mode === 'links') {
    const canShare = typeof navigator.share === 'function';
    $app.innerHTML = `
    <section class="card" aria-live="polite"><h2>Жеребьёвка проведена</h2>
      <p class="warn"><b>Не закрывайте страницу, пока не разошлёте ссылки.</b> После перезагрузки жеребьёвку придётся провести заново.</p>
      <ul class="links">${r.names
        .map(
          (n, i) => `<li><span class="nm">${esc(n)}</span><span class="actions" style="margin:0">
            <button type="button" data-action="copylink" data-i="${i}" aria-label="Скопировать ссылку для ${esc(n)}">Копировать ссылку</button>
            ${canShare ? `<button type="button" data-action="sharelink" data-i="${i}" aria-label="Поделиться ссылкой для ${esc(n)}">Поделиться</button>` : ''}
          </span></li>`,
        )
        .join('')}</ul>
      <div class="actions">
        <button type="button" data-action="copyall">Скопировать все ссылки списком</button>
        <button type="button" data-action="download">Скачать .txt</button>
      </div>
      <p class="hint" style="margin-top:12px">Ссылка раскрывает, кому дарить, но не шифруется. Отправляйте её только самому участнику. Если вы играете сами, не открывайте чужие ссылки.</p>
    </section>
    <div class="actions" style="margin-bottom:14px"><button type="button" data-action="again">Провести заново</button><button type="button" data-action="back">Изменить участников</button></div>`;
    return;
  }
  const open = r.open;
  $app.innerHTML = `
  <section class="card" aria-live="polite"><h2>Передавайте устройство по кругу</h2>
    <p class="hint">Каждый нажимает на своё имя, смотрит, кому дарить, и нажимает «Скрыть», прежде чем передать дальше.</p>
    <ul class="who">${r.names
      .map(
        (n, i) =>
          `<li><button type="button" data-action="open" data-i="${i}" aria-pressed="${open === i}">Я — ${esc(n)} ${r.seen.has(i) ? '<span class="seen">✓ уже смотрел(а)</span>' : ''}</button></li>`,
      )
      .join('')}</ul>
    <div id="reveal" class="reveal" ${open === null ? 'hidden' : ''}>${open === null ? '' : revealHtml(cardFor(r, open), 'hide')}</div>
  </section>
  <div class="actions" style="margin-bottom:14px"><button type="button" data-action="again">Провести заново</button><button type="button" data-action="back">Изменить участников</button></div>`;
}

function revealHtml(c: Card, hideAction: string): string {
  return `<p class="muted">${esc(c.from)}, вы дарите подарок:</p>
    <p class="target" data-testid="target">${esc(c.to)}</p>
    ${c.wish ? `<p><b>Пожелания:</b> ${esc(c.wish)}</p>` : ''}
    ${infoLines(c)}
    <button type="button" data-action="${hideAction}">Скрыть</button>`;
}

// ---------- Личная ссылка ----------

function renderCard(card: Card) {
  $app.innerHTML = `
  <section class="card center" aria-live="polite">
    <p class="muted">${esc(card.title)}</p>
    <h2>Привет, ${esc(card.from)}!</h2>
    <p>Вы — Тайный Санта. Подготовьтесь: никому не показывайте экран.</p>
    <button class="primary" type="button" data-action="show" data-testid="show">Узнать, кому дарить</button>
    <div id="reveal" class="reveal" hidden></div>
  </section>
  <p class="hint center">Это личная ссылка. Не пересылайте её другим участникам.</p>`;
  currentCard = card;
}

let currentCard: Card | null = null;

function renderBroken(msg: string) {
  $app.innerHTML = `<section class="card"><h2>Ссылка не открылась</h2><p>${esc(msg)}</p><p><a href="${esc(baseUrl())}">Провести свою жеребьёвку</a></p></section>`;
}

// ---------- Маршрутизация и события ----------

function render() {
  let card: Card | null = null;
  try {
    card = parseHash(location.hash);
  } catch (e) {
    renderBroken(e instanceof CardError ? e.message : 'Не удалось прочитать ссылку.');
    return;
  }
  currentCard = null;
  if (card) renderCard(card);
  else if (result) renderResult();
  else renderSetup();
  focusHeading();
}

function download(r: Result) {
  const text = `${r.title}\n\n${r.names.map((_, i) => linkText(r, i)).join('\n')}\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = 'secret-santa-links.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

$app.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  const i = Number(t.dataset.i);
  if (t.id === 'title') setup.title = t.value;
  else if (t.id === 'date') setup.date = t.value;
  else if (t.id === 'budget') setup.budget = t.value;
  else if (t.classList.contains('name')) {
    const old = setup.people[i].name.trim();
    setup.people[i].name = t.value;
    const now = t.value.trim();
    if (old && old !== now) setup.pairs = setup.pairs.filter(([a, b]) => a !== old && b !== old); // переименование сбрасывает исключения этого человека
    refreshPairs();
  } else if (t.classList.contains('wish')) setup.people[i].wish = t.value;
  else if (t.name === 'mode') setup.mode = t.value as Setup['mode'];
  else if (t.id === 'wishes') {
    setup.wishes = t.checked;
    save();
    renderSetup();
    document.getElementById('wishes')?.focus();
    return;
  } else return;
  save();
});

$app.addEventListener('submit', (e) => {
  e.preventDefault();
  startDraw();
});

$app.addEventListener('keydown', (e) => {
  const t = e.target as HTMLInputElement;
  if (e.key === 'Enter' && t.classList?.contains('name')) {
    e.preventDefault();
    const i = Number(t.dataset.i);
    if (i === setup.people.length - 1) setup.people.push({ name: '', wish: '' });
    save();
    renderSetup();
    (document.querySelectorAll<HTMLInputElement>('input.name')[i + 1] ?? t).focus();
  }
});

$app.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!b) return;
  const i = Number(b.dataset.i);
  switch (b.dataset.action) {
    case 'add':
      setup.people.push({ name: '', wish: '' });
      save();
      renderSetup();
      document.querySelectorAll<HTMLInputElement>('input.name')[setup.people.length - 1]?.focus();
      break;
    case 'remove': {
      const removed = setup.people[i].name.trim();
      setup.people.splice(i, 1);
      if (setup.people.length === 0) setup.people.push({ name: '', wish: '' });
      setup.pairs = setup.pairs.filter(([a, c]) => a !== removed && c !== removed);
      save();
      renderSetup();
      break;
    }
    case 'sample':
      setup.people = SAMPLE.map((name) => ({ name, wish: '' }));
      setup.pairs = [[SAMPLE[0], SAMPLE[1]]];
      save();
      renderSetup();
      break;
    case 'addpair': {
      const a = (document.getElementById('pa') as HTMLSelectElement).value;
      const c = (document.getElementById('pb') as HTMLSelectElement).value;
      if (!a || !c) return showProblems(['Сначала впишите имена участников.']);
      if (a === c) return showProblems(['Выберите двух разных людей.']);
      showProblems([]);
      if (!setup.pairs.some(([x, y]) => (x === a && y === c) || (x === c && y === a))) setup.pairs.push([a, c]);
      save();
      refreshPairs();
      break;
    }
    case 'rmpair':
      setup.pairs.splice(i, 1);
      save();
      refreshPairs();
      break;
    case 'copylink':
      void copy(cardUrl(baseUrl(), cardFor(result!, i)), `Ссылка для ${result!.names[i]} скопирована`);
      break;
    case 'sharelink': {
      const url = cardUrl(baseUrl(), cardFor(result!, i));
      void navigator.share({ title: result!.title, text: `${result!.names[i]}, ваша пара в «${result!.title}»`, url }).catch(() => {});
      break;
    }
    case 'copyall':
      void copy(result!.names.map((_, k) => linkText(result!, k)).join('\n'), 'Все ссылки скопированы');
      break;
    case 'download':
      download(result!);
      break;
    case 'again':
      result = null;
      startDraw();
      break;
    case 'back':
      result = null;
      render();
      break;
    case 'open':
      result!.open = i;
      result!.seen.add(i);
      renderResult();
      document.getElementById('reveal')?.scrollIntoView({ block: 'nearest' });
      break;
    case 'hide':
      result!.open = null;
      renderResult();
      break;
    case 'show': {
      const el = document.getElementById('reveal')!;
      el.hidden = false;
      el.innerHTML = revealHtml(currentCard!, 'hidecard');
      b.hidden = true;
      el.querySelector<HTMLElement>('button')?.focus();
      break;
    }
    case 'hidecard': {
      const el = document.getElementById('reveal')!;
      el.hidden = true;
      el.innerHTML = '';
      const show = $app.querySelector<HTMLElement>('[data-action="show"]')!;
      show.hidden = false;
      show.focus();
      break;
    }
  }
});

window.addEventListener('hashchange', render);
render();
