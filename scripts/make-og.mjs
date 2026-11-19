// Рисует OG-картинку 1200x630 для превью ссылки: web/og.png. Запуск вручную: npm run og
import { chromium } from '@playwright/test';

const html = `<!doctype html><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;font-family:system-ui,"Segoe UI",Roboto,sans-serif;color:#fff;
  background:radial-gradient(900px 500px at 85% 20%,#e04a4f 0%,transparent 60%),linear-gradient(135deg,#8f1a1f,#c2272d 55%,#6e1216);
  display:flex;align-items:center;padding:0 90px;gap:70px;overflow:hidden}
.t{flex:1}
h1{font-size:112px;line-height:1.02;font-weight:800;letter-spacing:-2px}
p{font-size:38px;margin-top:26px;opacity:.92;line-height:1.3}
.u{position:absolute;left:90px;bottom:48px;font-size:28px;opacity:.8}
.snow i{position:absolute;width:14px;height:14px;border-radius:50%;background:#fff;opacity:.55}
</style>
<div class="t"><h1>Тайный<br>Санта</h1><p>Жеребьёвка для компании.<br>Без регистрации, с исключениями для пар.</p></div>
<svg width="360" height="360" viewBox="0 0 64 64"><rect x="8" y="26" width="48" height="30" rx="3" fill="#fff"/><rect x="4" y="18" width="56" height="12" rx="3" fill="#ffe3e3"/><rect x="28" y="18" width="8" height="38" fill="#ffd166"/><path d="M32 18c-8-10-18-6-14 0 3 4 14 0 14 0zM32 18c8-10 18-6 14 0-3 4-14 0-14 0z" fill="#ffd166"/></svg>
<div class="u">oleg4311.github.io/secret-santa</div>
<div class="snow">${Array.from({ length: 26 }, (_, i) => `<i style="left:${(i * 463) % 1180}px;top:${(i * 211) % 600}px;transform:scale(${0.5 + ((i * 7) % 10) / 10})"></i>`).join('')}</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.screenshot({ path: 'web/og.png' });
await browser.close();
console.log('web/og.png');
