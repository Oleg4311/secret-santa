// Скриншоты для README (телефонный экран): настройка и личная ссылка. Запуск: node scripts/screenshot.mjs
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.env.BASE_URL ?? 'http://127.0.0.1:4176/';
mkdirSync('docs', { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
await page.goto(url);
await page.evaluate(() => localStorage.clear());
await page.goto(url);
await page.getByRole('button', { name: 'Заполнить примером' }).click();
await page.getByLabel('Бюджет').fill('до 1500 ₽');
await page.getByLabel('Когда обмениваетесь').fill('25 декабря');
await page.evaluate(() => document.activeElement?.blur());
await page.getByRole('heading', { name: 'Участники' }).evaluate((h) => h.scrollIntoView({ block: 'start' }));
await page.screenshot({ path: 'docs/setup.png', fullPage: false });

await page.getByTestId('go').click();
await page.getByRole('button', { name: 'Скопировать все ссылки списком' }).click();
const text = await page.evaluate(() => navigator.clipboard.readText());
const link = text.split('\n').find((l) => l.startsWith('Вера:')).slice('Вера: '.length);
const card = await context.newPage();
await card.goto(link);
await card.getByTestId('show').click();
await card.screenshot({ path: 'docs/reveal.png', fullPage: false });
await browser.close();
console.log('docs/setup.png docs/reveal.png');
