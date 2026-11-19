// Жеребьёвка «Тайного Санты»: каждый дарит ровно одному, получает ровно от одного, не себе и не тем, кого исключили.
// Это поиск совершенного паросочетания в двудольном графе «кто кому может дарить».

export type Rng = () => number;

export type DrawResult =
  | { ok: true; giftee: number[] } // giftee[i] — индекс того, кому дарит i
  | { ok: false; reason: string };

/** Генератор для тестов: детерминированный, чтобы результаты воспроизводились. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Криптографически стойкий источник случайности для настоящей жеребьёвки. */
export function secureRng(): Rng {
  return () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

function shuffled<T>(items: T[], rng: Rng): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** allowed[i][j]: может ли i дарить j. Исключения взаимные: пара не дарит друг другу ни в какую сторону. */
export function allowedMatrix(n: number, forbiddenPairs: Array<[number, number]>): boolean[][] {
  const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i !== j));
  for (const [a, b] of forbiddenPairs) {
    if (a >= 0 && a < n && b >= 0 && b < n) {
      m[a][b] = false;
      m[b][a] = false;
    }
  }
  return m;
}

/** Проверка готового результата: используется в тестах и как страховка перед показом. */
export function isValid(giftee: number[], allowed: boolean[][]): boolean {
  const n = allowed.length;
  if (giftee.length !== n) return false;
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const j = giftee[i];
    if (!Number.isInteger(j) || j < 0 || j >= n || !allowed[i][j] || seen.has(j)) return false;
    seen.add(j);
  }
  return true;
}

/**
 * Проводит жеребьёвку.
 * 1. Быстрые отказы: у кого-то нет ни одного возможного получателя или дарителя.
 * 2. Случайные перестановки с проверкой. Результат равномерен среди всех допустимых.
 * 3. Если ограничения жёсткие и перебор не нашёл ответ, поиск чередующимися цепями (алгоритм Куна)
 *    в случайном порядке: найдёт ответ, если он существует, но распределение уже не строго равномерное.
 * 4. Если ответа нет, объясняет почему (нарушено условие Холла: группе людей достаточно меньшего числа получателей).
 */
export function draw(names: string[], forbiddenPairs: Array<[number, number]>, rng: Rng, attempts = 300): DrawResult {
  const n = names.length;
  if (n < 2) return { ok: false, reason: 'Нужно минимум два участника.' };
  const allowed = allowedMatrix(n, forbiddenPairs);

  for (let i = 0; i < n; i++) {
    if (!allowed[i].some(Boolean)) return { ok: false, reason: `«${names[i]}» некому дарить: исключены все возможные получатели.` };
    if (!allowed.some((row) => row[i])) return { ok: false, reason: `«${names[i]}» некому дарить подарок: исключены все возможные дарители.` };
  }

  const idx = Array.from({ length: n }, (_, i) => i);
  for (let t = 0; t < attempts; t++) {
    const perm = shuffled(idx, rng);
    if (isValid(perm, allowed)) return { ok: true, giftee: perm };
  }

  // Запасной путь: паросочетание поиском в глубину по чередующимся цепям
  const matchOfTarget: number[] = Array(n).fill(-1);
  for (const giver of shuffled(idx, rng)) {
    const visitedTargets = new Set<number>();
    const visitedGivers = new Set<number>([giver]);
    const tryGiver = (g: number): boolean => {
      for (const target of shuffled(idx, rng)) {
        if (!allowed[g][target] || visitedTargets.has(target)) continue;
        visitedTargets.add(target);
        const holder = matchOfTarget[target];
        if (holder === -1 || (visitedGivers.add(holder), tryGiver(holder))) {
          matchOfTarget[target] = g;
          return true;
        }
      }
      return false;
    };
    if (!tryGiver(giver)) {
      const group = [...visitedGivers].map((g) => `«${names[g]}»`).join(', ');
      return {
        ok: false,
        reason: `Ограничения слишком жёсткие. Для ${group} возможных получателей всего ${visitedTargets.size}, а дарителей ${visitedGivers.size}. Уберите часть исключений.`,
      };
    }
  }
  const giftee: number[] = Array(n).fill(-1);
  matchOfTarget.forEach((g, target) => (giftee[g] = target));
  return { ok: true, giftee };
}
