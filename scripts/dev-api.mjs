// Локальный API для e2e и разработки: собранный Worker в Miniflare на 127.0.0.1:8787 (разрешён адрес страницы 127.0.0.1:4176).
import { execFileSync } from 'node:child_process';
import { Miniflare } from 'miniflare';

execFileSync(process.execPath, ['scripts/build-worker.mjs'], { stdio: 'inherit' });
const mf = new Miniflare({
  host: '127.0.0.1',
  port: 8787,
  modules: true,
  scriptPath: 'worker/dist/index.mjs',
  durableObjects: { GAME: { className: 'GameDO', useSQLite: true } },
  bindings: { ALLOWED_ORIGINS: 'http://127.0.0.1:4176' },
  compatibilityDate: '2026-08-01',
});
await mf.ready;
console.log('http://127.0.0.1:8787/');
process.on('SIGINT', async () => {
  await mf.dispose();
  process.exit(0);
});
