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
copyFileSync('web/index.html', 'site/index.html');
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
