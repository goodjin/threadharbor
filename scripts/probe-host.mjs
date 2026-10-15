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
  await page.waitForTimeout(2000);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-host-row]')].map(r => ({
      hostId: r.querySelector('[data-host-id-label]')?.textContent,
      name: r.querySelector('[data-host-name]')?.textContent,
      secondary: r.querySelector('[data-host-id-label]')?.textContent ?? null,
      badge: r.querySelector('[data-host-badge]')?.textContent,
    })));
  console.log('ROWS:', JSON.stringify(rows));

  const hasRow = await page.evaluate(() => !!document.querySelector('[data-host-row] [data-host-open]'));
  if (hasRow) {
    await page.evaluate(() => document.querySelector('[data-host-row] [data-host-open]').click());
    await page.waitForTimeout(900);
    const detail = await page.evaluate(() => {
      const panel = document.querySelector('[data-threadharbor-panel]');
      const field = (sel) => {
        const el = panel.querySelector(sel);
        if (!el) return null;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return { kind: 'input', value: el.value };
        return { kind: 'text', value: el.textContent.trim() };
      };
      return {
        page: panel.querySelector('[data-panel-page]')?.getAttribute('data-panel-page'),
        id: field('[data-form-field-id=""]'),
        title: field('[data-form-field-title=""]'),
        address: field('[data-form-field-address=""]'),
        facts: [...panel.querySelectorAll('[data-reported-facts] p')].map(p => p.textContent.trim()),
      };
    });
    console.log('DETAIL:', JSON.stringify(detail, null, 2));
  } else {
    console.log('(no host rows to open)');
  }

  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
