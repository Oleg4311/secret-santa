import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

const NAMES = ['Анна', 'Борис', 'Вера', 'Глеб'];

async function newPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const ctx = await browser.newContext({ baseURL, permissions: ['clipboard-read', 'clipboard-write'] });
  return ctx.newPage();
}

test('общая игра: слепой организатор, места, жеребьёвка, анонимный вопрос и ответ', async ({ browser, baseURL }) => {
  const org = await newPage(browser, baseURL);
  await org.goto('./online.html');
  await org.getByLabel('Участники').fill(NAMES.join('\n'));
  await org.getByLabel('Кто не дарит друг другу').fill('Анна + Борис');
  await org.getByRole('button', { name: 'Создать игру' }).click();
  await expect(org.getByRole('heading', { name: 'Игра создана' })).toBeVisible();

  // ссылки приглашений берём так, как это сделал бы организатор: кнопка «Скопировать ссылку» у каждого имени
  const invites = new Map<string, string>();
  for (const n of NAMES) {
    await org.locator('li', { hasText: n }).getByRole('button', { name: 'Скопировать ссылку' }).click();
    invites.set(n, await org.evaluate(() => navigator.clipboard.readText()));
  }
  expect(new Set(invites.values()).size).toBe(4);

  await org.getByRole('link', { name: 'Открыть' }).click();
  await expect(org.getByRole('button', { name: 'Ждём участников: 0 из 4' })).toBeDisabled();

  const people = new Map<string, Page>();
  for (const n of NAMES) {
    const p = await newPage(browser, baseURL);
    await p.goto(invites.get(n)!);
    await p.getByRole('button', { name: 'Занять место' }).click();
    await expect(p.getByRole('heading', { name: new RegExp(`${n}, вы в игре`) })).toBeVisible();
    people.set(n, p);
  }

  // приглашение сгорело: второй человек по той же ссылке получает отказ
  const thief = await newPage(browser, baseURL);
  await thief.goto(invites.get('Анна')!);
  await thief.getByRole('button', { name: 'Занять место' }).click();
  await expect(thief.getByRole('alert')).toContainText('уже использовано');

  const draw = org.getByRole('button', { name: 'Провести жеребьёвку' });
  await expect(draw).toBeEnabled({ timeout: 20_000 });
  await draw.click();
  await expect(org.getByRole('button', { name: 'Жеребьёвка проведена' })).toBeDisabled();
  await expect(org.getByText('вы дарите подарок')).toHaveCount(0);

  const target = new Map<string, string>();
  for (const [n, p] of people) {
    await p.reload();
    await expect(p.getByText(`${n}, вы дарите подарок:`)).toBeVisible();
    target.set(n, (await p.locator('.target').innerText()).trim());
  }
  expect(new Set(target.values()).size).toBe(4);
  for (const [n, t] of target) expect(t).not.toBe(n);
  expect(target.get('Анна')).not.toBe('Борис');
  expect(target.get('Борис')).not.toBe('Анна');

  // анонимный вопрос от Анны её подопечному
  const giftee = target.get('Анна')!;
  await people.get('Анна')!.getByLabel('Ваш вопрос').fill('Какой любимый цвет?');
  await people.get('Анна')!.getByRole('button', { name: 'Спросить' }).click();
  await expect(people.get('Анна')!.getByText('Ответа пока нет')).toBeVisible();

  const gp = people.get(giftee)!;
  await gp.reload();
  const inbox = gp.locator('section', { hasText: 'Вопросы вам от тайного Санты' });
  await expect(inbox).toContainText('Какой любимый цвет?');
  await expect(inbox).not.toContainText('Анна');
  await inbox.getByRole('textbox').fill('Зелёный');
  await inbox.getByRole('button', { name: 'Ответить' }).click();
  await expect(gp.getByText('Ответ отправлен')).toBeVisible();

  const ap = people.get('Анна')!;
  await ap.reload();
  await expect(ap.getByText('Ответ: Зелёный')).toBeVisible();

  // организатор видит, кто открыл пару, но не пары
  await org.reload();
  await expect(org.locator('li', { hasText: 'Анна' })).toContainText('открыл(а) пару');

  // удаление игры организатором
  org.once('dialog', (d) => void d.accept());
  await org.getByRole('button', { name: 'Удалить игру' }).click();
  await expect(org.getByRole('heading', { name: 'Игра удалена' })).toBeVisible();
  await ap.reload();
  await expect(ap.getByRole('alert')).toContainText('Не найдено');
});

test('доступность страницы создания и неверная ссылка', async ({ page }) => {
  await page.goto('./online.html');
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.map((v) => v.id)).toEqual([]);
  await page.goto('./online.html#/p/нет/нет');
  await expect(page.getByRole('alert')).toContainText('Ссылка повреждена');
});

test('невозможные исключения: понятная ошибка до создания', async ({ page }) => {
  await page.goto('./online.html');
  await page.getByLabel('Участники').fill('а\nб\nв');
  await page.getByLabel('Кто не дарит друг другу').fill('а + б\nа + в');
  await page.getByRole('button', { name: 'Создать игру' }).click();
  await expect(page.getByRole('alert').first()).toContainText('некому дарить');
});
