import { chromium } from '/Users/good/claude/skills/content-collector/scripts/node_modules/playwright-core/index.mjs';
const TOKEN = process.argv[2];
const BASE = 'http://127.0.0.1:3081';
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Users/good/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    args: ['--no-proxy-server', '--proxy-bypass-list=127.0.0.1;localhost;<local>'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.replace(/\s/g, '').includes('各主机'));
    if (b) b.click();
  });
  await page.waitForTimeout(2500);
  // open add page
  await page.evaluate(() => document.querySelector('[data-action="add-host"]')?.click());
  await page.waitForTimeout(1000);
  const hasPick = await page.evaluate(() => !!document.querySelector('[data-action="tailscale-pick"]'));
  console.log('HAS_PICK_BUTTON:', hasPick);
  if (!hasPick) { console.log('(no pick button — tailscale port missing?)'); await browser.close(); return; }
  await page.evaluate(() => document.querySelector('[data-action="tailscale-pick"]').click());
  await page.waitForTimeout(1500);
  const picker = await page.evaluate(() => {
    const p = document.querySelector('[data-tailscale-picker]');
    if (!p) return { present: false };
    const peers = [...p.querySelectorAll('[data-tailscale-peer]')].map(el => ({
      name: el.getAttribute('data-tailscale-peer'),
      online: el.getAttribute('data-tailscale-online'),
      text: el.textContent.replace(/\s+/g, ' ').trim(),
    }));
    const state = p.querySelector('[data-tailscale-state]')?.getAttribute('data-tailscale-state') ?? null;
    const note = p.querySelector('[data-tailscale-note]')?.textContent ?? null;
    return { present: true, peers, state, note };
  });
  console.log('PICKER:', JSON.stringify(picker, null, 2));
  // 桥在 web 重启时（那时还没登录）跑过一次；点刷新让它按现在的 tailnet 重跑
  await page.evaluate(() => document.querySelector('[data-action="tailscale-refresh"]')?.click());
  await page.waitForTimeout(3500);
  const after = await page.evaluate(() => {
    const p = document.querySelector('[data-tailscale-picker]');
    if (!p) return { present: false };
    return {
      peers: [...p.querySelectorAll('[data-tailscale-peer]')].map(el => ({
        name: el.getAttribute('data-tailscale-peer'),
        online: el.getAttribute('data-tailscale-online'),
        text: el.textContent.replace(/\s+/g, ' ').trim(),
      })),
      note: p.querySelector('[data-tailscale-note]')?.textContent ?? null,
    };
  });
  console.log('AFTER_REFRESH:', JSON.stringify(after, null, 2));
  // select the first online peer (or first peer)
  const first = await page.evaluate(() => {
    const peers = [...document.querySelectorAll('[data-tailscale-peer]')];
    if (peers.length === 0) return null;
    const online = peers.find(p => p.getAttribute('data-tailscale-online') === 'true') ?? peers[0];
    online.click();
    return online.getAttribute('data-tailscale-peer');
  });
  await page.waitForTimeout(600);
  const address = await page.evaluate(() => {
    const el = document.querySelector('[data-form-field-address=""]');
    return el ? el.value : null;
  });
  console.log('SELECTED:', first, '-> ADDRESS:', address);
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
