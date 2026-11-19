import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedMatrix, draw, isValid, mulberry32 } from '../src/draw.ts';

const names = (n: number) => Array.from({ length: n }, (_, i) => `P${i}`);

test('результат — перестановка без самоподарков', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = draw(names(6), [], mulberry32(seed));
    assert.ok(r.ok);
    if (r.ok) assert.ok(isValid(r.giftee, allowedMatrix(6, [])), `seed ${seed}: ${r.giftee}`);
  }
});

test('исключённые пары не дарят друг другу ни в одну сторону', () => {
  const pairs: Array<[number, number]> = [[0, 1], [2, 3]];
  for (let seed = 1; seed <= 300; seed++) {
    const r = draw(names(6), pairs, mulberry32(seed));
    assert.ok(r.ok);
    if (!r.ok) return;
    for (const [a, b] of pairs) {
      assert.notEqual(r.giftee[a], b, `seed ${seed}: ${a} -> ${b}`);
      assert.notEqual(r.giftee[b], a, `seed ${seed}: ${b} -> ${a}`);
    }
  }
});

test('детерминированность: тот же seed даёт тот же результат', () => {
  const a = draw(names(8), [[0, 1]], mulberry32(42));
  const b = draw(names(8), [[0, 1]], mulberry32(42));
  assert.deepEqual(a, b);
});

// Сверка с полным перебором: алгоритм находит ответ ровно тогда, когда он существует.
function bruteForceExists(allowed: boolean[][]): boolean {
  const n = allowed.length;
  const used = new Array(n).fill(false);
  const go = (i: number): boolean => {
    if (i === n) return true;
    for (let j = 0; j < n; j++) {
      if (allowed[i][j] && !used[j]) {
        used[j] = true;
        if (go(i + 1)) return true;
        used[j] = false;
      }
    }
    return false;
  };
  return go(0);
}

test('сверка с полным перебором на случайных ограничениях (n ≤ 7)', () => {
  const rng = mulberry32(2026);
  let feasible = 0;
  let infeasible = 0;
  for (let trial = 0; trial < 1500; trial++) {
    const n = 3 + Math.floor(rng() * 5);
    const pairs: Array<[number, number]> = [];
    const count = Math.floor(rng() * (n + 3));
    for (let k = 0; k < count; k++) {
      const a = Math.floor(rng() * n);
      const b = Math.floor(rng() * n);
      if (a !== b) pairs.push([a, b]);
    }
    const allowed = allowedMatrix(n, pairs);
    const expected = bruteForceExists(allowed);
    const r = draw(names(n), pairs, mulberry32(trial + 1), 20); // мало попыток: проверяем и запасной алгоритм
    assert.equal(r.ok, expected, `n=${n} pairs=${JSON.stringify(pairs)}`);
    if (r.ok) {
      assert.ok(isValid(r.giftee, allowed), `невалидный ответ ${r.giftee} для ${JSON.stringify(pairs)}`);
      feasible++;
    } else {
      assert.ok(r.reason.length > 10);
      infeasible++;
    }
  }
  assert.ok(feasible > 300 && infeasible > 100, `неинформативная выборка: ${feasible}/${infeasible}`);
});

test('запасной алгоритм находит ответ, когда перебор перестановок почти не попадает', () => {
  // 8 человек: 4 пары исключены. Допустимых перестановок мало, попыток всего 1.
  const pairs: Array<[number, number]> = [[0, 1], [2, 3], [4, 5], [6, 7]];
  const allowed = allowedMatrix(8, pairs);
  for (let seed = 1; seed <= 100; seed++) {
    const r = draw(names(8), pairs, mulberry32(seed), 1);
    assert.ok(r.ok);
    if (r.ok) assert.ok(isValid(r.giftee, allowed));
  }
});

test('равномерность: при n=4 все 9 беспорядков выпадают примерно поровну', () => {
  const rng = mulberry32(7);
  const counts = new Map<string, number>();
  const runs = 9000;
  for (let i = 0; i < runs; i++) {
    const r = draw(names(4), [], rng);
    assert.ok(r.ok);
    if (r.ok) counts.set(r.giftee.join(','), (counts.get(r.giftee.join(',')) ?? 0) + 1);
  }
  assert.equal(counts.size, 9);
  for (const [perm, c] of counts) assert.ok(c > 800 && c < 1200, `${perm}: ${c} из ${runs}`);
});

test('отказ: у человека нет ни одного возможного получателя', () => {
  const r = draw(['Аня', 'Борис', 'Вера'], [[0, 1], [0, 2]], mulberry32(1));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /«Аня» некому дарить/);
});

test('отказ: условие Холла, двум людям достаётся один получатель, и причина называет их', () => {
  // A и B могут дарить только D (с C и между собой они исключены)
  const r = draw(['A', 'B', 'C', 'D'], [[0, 1], [0, 2], [1, 2]], mulberry32(1));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /слишком жёсткие/);
    assert.match(r.reason, /«[ABC]»/);
  }
});

test('два участника: единственный допустимый обмен', () => {
  const r = draw(['A', 'B'], [], mulberry32(1));
  assert.deepEqual(r, { ok: true, giftee: [1, 0] });
  assert.equal(draw(['A'], [], mulberry32(1)).ok, false);
});

test('allowedMatrix игнорирует индексы вне диапазона', () => {
  const m = allowedMatrix(3, [[0, 9], [-1, 1]]);
  assert.ok(m[0][1] && m[1][0]);
});
