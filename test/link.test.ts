import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CardError, cardUrl, decodeCard, encodeCard, parseHash, type Card } from '../src/link.ts';

const card: Card = { title: 'Тайный Санта 2026', from: 'Анна', to: 'Борис «Бо»', wish: 'книги, носки 🧦', budget: 'до 1500 ₽', date: '25 декабря' };

test('кодирование и разбор сохраняют юникод и все поля', () => {
  assert.deepEqual(decodeCard(encodeCard(card)), card);
});

test('необязательные поля не попадают в ссылку', () => {
  const t = encodeCard({ title: 'Игра', from: 'А', to: 'Б' });
  assert.deepEqual(decodeCard(t), { title: 'Игра', from: 'А', to: 'Б' });
  assert.ok(t.length < 60, `ссылка без пожеланий должна быть короткой: ${t.length}`);
});

test('токен безопасен для URL: без +, / и =', () => {
  for (let i = 0; i < 50; i++) assert.match(encodeCard({ ...card, wish: 'я'.repeat(i) }), /^[A-Za-z0-9_-]+$/);
});

test('cardUrl и parseHash — обратные операции', () => {
  const url = cardUrl('https://example.org/app/?x=1#/old', card);
  assert.ok(url.startsWith('https://example.org/app/?x=1#/r/'));
  assert.deepEqual(parseHash(url.slice(url.indexOf('#'))), card);
  assert.equal(parseHash('#/'), null);
  assert.equal(parseHash(''), null);
});

test('повреждённые ссылки дают понятную ошибку, а не падение', () => {
  const bad = ['!!!', 'AAAA', encodeCard(card).slice(0, -6), btoa('{"v":2}'), btoa('[]'), btoa('null'), btoa('{"v":1}')];
  for (const t of bad) assert.throws(() => decodeCard(t), CardError, `токен ${t}`);
});

test('слишком длинные значения отклоняются', () => {
  const evil = btoa(JSON.stringify({ v: 1, t: 'x', f: 'a'.repeat(500), o: 'b' }));
  assert.throws(() => decodeCard(evil), CardError);
});

test('HTML в именах не интерпретируется на уровне данных: это просто строка', () => {
  const evil: Card = { title: '<img src=x onerror=alert(1)>', from: '<b>a</b>', to: '"><script>' };
  assert.deepEqual(decodeCard(encodeCard(evil)), evil); // экранирование выполняется при выводе, см. e2e
});
