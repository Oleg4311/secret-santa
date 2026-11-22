// Сборка сайта в site/: бандл приложения, страница, OG-картинка и version.json с коммитом.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

rmSync('site', { recursive: true, force: true });
mkdirSync('site');

await build({
  entryPoints: ['src/app.ts'],
  outfile: 'site/app.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
});
// Адрес API онлайн-режима: переменная API_URL при сборке (в CI задаётся из деплоя Worker), иначе локальный wrangler dev.
const apiUrl = (process.env.API_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
await build({
  entryPoints: ['src/online.ts'],
  outfile: 'site/online.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  define: { API_URL: JSON.stringify(apiUrl) },
});
copyFileSync('web/index.html', 'site/index.html');
copyFileSync('web/online.html', 'site/online.html');
if (existsSync('web/og.png')) copyFileSync('web/og.png', 'site/og.png');

let commit = process.env.GITHUB_SHA;
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    commit = undefined;
  }
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (commit) writeFileSync('site/version.json', JSON.stringify({ commit, version: pkg.version, builtAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`site/ готов${commit ? `, коммит ${commit.slice(0, 7)}` : ''}`);
