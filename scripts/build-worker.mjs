// Собирает Worker в один модуль worker/dist/index.mjs (его же загружают тесты Miniflare и wrangler deploy).
import { build } from 'esbuild';

await build({
  entryPoints: ['worker/index.ts'],
  outfile: 'worker/dist/index.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
});
console.log('worker/dist/index.mjs');
