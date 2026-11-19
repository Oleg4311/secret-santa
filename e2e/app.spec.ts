import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const SAMPLE = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дарья', 'Егор'];

async function startSample(page: Page) {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.goto('./');
  await page.getByRole('button', { name: 'Заполнить примером' }).click();
}

/** Забирает все личные ссылки так, как это сделал бы организатор: кнопкой «Скопировать все ссылки». */
async function copyAllLinks(page: Page): Promise<Map<string, string>> {
  await page.getByRole('button', { name: 'Скопировать все ссылки списком' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const links = new Map<string, string>();
  for (const line of text.split('\n').filter((l) => l.includes(': http'))) {
    const at = line.indexOf(': http');
    links.set(line.slice(0, at), line.slice(at + 2));
  }
  return links;
}

/** Открывает ссылку участника в чистой странице и возвращает, кому он дарит. */
async function openLink(context: BrowserContext, url: string, who: string): Promise<string> {
  const p = await context.newPage();
  await p.goto(url);
  await expect(p.getByRole('heading', { name: `Привет, ${who}!` })).toBeVisible();
  await expect(p.getByTestId('target')).toHaveCount(0); // до нажатия цели в DOM нет
  await p.getByTestId('show').click();
  const target = (await p.getByTestId('target').innerText()).trim();
  await p.close();
  return target;
}

test('ссылки: у всех ровно одна пара, самоподарков и исключений нет, организатор чужих пар не видит', async ({ page, context }) => {
  await startSample(page);
  await page.getByTestId('go').click();
  await expect(page.getByRole('heading', { name: 'Жеребьёвка проведена' })).toBeVisible();

  // на экране организатора нет ни одной цели
  await expect(page.getByTestId('target')).toHaveCount(0);
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('вы дарите');

  const links = await copyAllLinks(page);
  expect([...links.keys()].sort()).toEqual([...SAMPLE].sort());

  const gift = new Map<string, string>();
  for (const [name, url] of links) gift.set(name, await openLink(context, url, name));

  expect([...gift.values()].sort(), 'каждый получает подарок ровно от одного').toEqual([...SAMPLE].sort());
  for (const [from, to] of gift) expect(to, `${from} дарит себе`).not.toBe(from);
  expect(gift.get('Анна')).not.toBe('Борис'); // исключённая пара
  expect(gift.get('Борис')).not.toBe('Анна');
});

test('ссылка: «Скрыть» убирает цель из страницы, повторный показ возможен', async ({ page, context }) => {
  await startSample(page);
  await page.getByTestId('go').click();
  const links = await copyAllLinks(page);
  const p = await context.newPage();
  await p.goto(links.get('Вера')!);
  await p.getByTestId('show').click();
  await expect(p.getByTestId('target')).toBeVisible();
  const first = await p.getByTestId('target').innerText();
  await p.getByRole('button', { name: 'Скрыть' }).click();
  await expect(p.getByTestId('target')).toHaveCount(0);
  await p.getByTestId('show').click();
  await expect(p.getByTestId('target')).toHaveText(first);
});

test('одно устройство: цель видна только после нажатия и исчезает после «Скрыть»', async ({ page }) => {
  await startSample(page);
  await page.getByLabel(/По кругу на одном устройстве/).check();
  await page.getByTestId('go').click();
  await expect(page.getByRole('heading', { name: 'Передавайте устройство по кругу' })).toBeVisible();
  await expect(page.getByTestId('target')).toHaveCount(0);

  const gift = new Map<string, string>();
  for (const name of SAMPLE) {
    await page.getByRole('button', { name: new RegExp(`^Я — ${name}`) }).click();
    await expect(page.getByTestId('target')).toBeVisible();
    gift.set(name, (await page.getByTestId('target').innerText()).trim());
    await page.getByRole('button', { name: 'Скрыть' }).click();
    await expect(page.getByTestId('target')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('вы дарите');
  }
  await expect(page.getByText('✓ уже смотрел(а)')).toHaveCount(SAMPLE.length);
  expect([...gift.values()].sort()).toEqual([...SAMPLE].sort());
  for (const [from, to] of gift) expect(to).not.toBe(from);
  expect(gift.get('Анна')).not.toBe('Борис');
  expect(gift.get('Борис')).not.toBe('Анна');
});

test('пожелания получателя попадают в ссылку дарителя', async ({ page, context }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.goto('./');
  await page.getByRole('button', { name: 'Заполнить примером' }).click();
  await expect(page.getByLabel('Пожелания участника 1, необязательно')).toHaveCount(0); // по умолчанию поля пожеланий скрыты
  await page.getByLabel(/Собирать пожелания к подаркам/).check();
  for (let i = 0; i < SAMPLE.length; i++) await page.getByLabel(`Пожелания участника ${i + 1}, необязательно`).fill(`хочет ${SAMPLE[i]}-подарок`);
  await page.getByLabel('Бюджет').fill('до 1500 ₽');
  await page.getByTestId('go').click();
  const links = await copyAllLinks(page);
  const p = await context.newPage();
  await p.goto(links.get('Глеб')!);
  await p.getByTestId('show').click();
  const target = (await p.getByTestId('target').innerText()).trim();
  await expect(p.getByText(`хочет ${target}-подарок`)).toBeVisible();
  await expect(p.getByText('Бюджет: до 1500 ₽')).toBeVisible();
});

test('невозможные ограничения объясняются понятно', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.goto('./');
  for (const [i, n] of ['Аня', 'Боря', 'Вика'].entries()) await page.getByLabel(`Имя участника ${i + 1}`, { exact: true }).fill(n);
  await page.locator('#pa').selectOption('Аня');
  await page.locator('#pb').selectOption('Боря');
  await page.getByRole('button', { name: 'Добавить исключение' }).click();
  await page.locator('#pb').selectOption('Вика');
  await page.getByRole('button', { name: 'Добавить исключение' }).click();
  await page.getByTestId('go').click();
  await expect(page.getByRole('alert')).toContainText('«Аня» некому дарить');
});

test('проверки ввода: мало участников и повторяющиеся имена', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.goto('./');
  await page.getByLabel('Имя участника 1', { exact: true }).fill('Аня');
  await page.getByTestId('go').click();
  await expect(page.getByRole('alert')).toContainText('минимум трёх участников');

  await page.getByLabel('Имя участника 2', { exact: true }).fill('аня');
  await page.getByLabel('Имя участника 3', { exact: true }).fill('Боря');
  await page.getByTestId('go').click();
  await expect(page.getByRole('alert')).toContainText('повторяется');
});

test('исключения: удаляются вместе с участником и при переименовании', async ({ page }) => {
  await startSample(page);
  await expect(page.locator('#pairs')).toContainText('Анна и Борис');
  await page.getByLabel('Имя участника 2', { exact: true }).fill('Борис К.');
  await expect(page.locator('#pairs')).not.toContainText('Анна и Борис');
  await page.locator('#pa').selectOption('Анна');
  await page.locator('#pb').selectOption('Вера');
  await page.getByRole('button', { name: 'Добавить исключение' }).click();
  await expect(page.locator('#pairs')).toContainText('Анна и Вера');
  await page.getByRole('button', { name: 'Убрать исключение Анна и Вера' }).click();
  await expect(page.locator('#pairs')).toBeEmpty();
});

test('настройки игры переживают перезагрузку', async ({ page }) => {
  await startSample(page);
  await page.getByLabel('Название').fill('Офис 2026');
  await page.reload();
  await expect(page.getByLabel('Название')).toHaveValue('Офис 2026');
  await expect(page.getByLabel('Имя участника 3', { exact: true })).toHaveValue('Вера');
  await expect(page.locator('#pairs')).toContainText('Анна и Борис');
});

test('повреждённая ссылка не ломает приложение', async ({ page }) => {
  await page.goto('./#/r/AAAA');
  await expect(page.getByRole('heading', { name: 'Ссылка не открылась' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Провести свою жеребьёвку' })).toBeVisible();
});

test('HTML в именах и пожеланиях выводится как текст и не исполняется', async ({ page }) => {
  const token = Buffer.from(
    JSON.stringify({ v: 1, t: '<b>игра</b>', f: '<img src=x onerror=window.__pwned=1>', o: '<script>window.__pwned=2</script>', w: '"><svg onload=window.__pwned=3>' }),
  ).toString('base64url');
  await page.goto(`./#/r/${token}`);
  await expect(page.getByRole('heading', { level: 2 })).toContainText('<img src=x onerror=window.__pwned=1>');
  await page.getByTestId('show').click();
  await expect(page.getByTestId('target')).toHaveText('<script>window.__pwned=2</script>');
  await expect(page.getByText('"><svg onload=window.__pwned=3>')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator('main img, main script, main svg').count()).toBe(0);
});

test('нет горизонтальной прокрутки на любом экране', async ({ page }) => {
  await startSample(page);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByTestId('go').click();
  expect(await overflow()).toBeLessThanOrEqual(0);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`доступность (axe) в ${scheme === 'light' ? 'светлой' : 'тёмной'} теме: нет серьёзных нарушений`, async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const check = async (label: string, p: Page) => {
      const res = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html}`), label).toEqual([]);
    };
    await startSample(page);
    await check('настройка', page);
    await page.getByTestId('go').click();
    await check('результаты (ссылки)', page);
    const links = await copyAllLinks(page);
    const card = await context.newPage();
    await card.emulateMedia({ colorScheme: scheme });
    await card.goto(links.get('Анна')!);
    await check('карточка', card);
    await card.getByTestId('show').click();
    await check('карточка после показа', card);
  });
}
