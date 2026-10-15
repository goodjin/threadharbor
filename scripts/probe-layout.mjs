import { chromium } from '/Users/good/claude/skills/content-collector/scripts/node_modules/playwright-core/index.mjs';

const TOKEN = process.argv[2];
const BASE = 'http://127.0.0.1:3081';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Users/good/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    args: ['--no-proxy-server', '--proxy-bypass-list=127.0.0.1;localhost;<local>'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on('console', m => { if (m.type() === 'error') console.log('PAGE-ERR:', m.text().slice(0, 160)); });
  page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0, 160)));
  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Dump all buttons to find the hosts nav.
  const buttonTexts = await page.evaluate(() =>
    [...document.querySelectorAll('button')].map(b => b.textContent.replace(/\s+/g, '').slice(0, 24)));
  console.log('buttons:', JSON.stringify(buttonTexts));

  // Click the 各主机 nav button (substring match).
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => x.textContent.replace(/\s/g, '').includes('各主机') || x.textContent.replace(/\s/g, '').includes('主机'));
    if (b) { b.click(); return b.textContent.replace(/\s/g, ''); }
    return false;
  });
  await page.waitForTimeout(800);
  console.log('clicked:', clicked);

  const info = await page.evaluate(() => {
    const panel = document.querySelector('[data-threadharbor-panel]');
    if (!panel) return { error: 'no panel' };
    const root = panel; // data-threadharbor-panel is on the root div
    const cs = (el) => el ? getComputedStyle(el) : null;
    const list = panel.querySelector('[data-host-list]');
    const head = panel.querySelector('[data-host-list-head]');
    const firstRow = panel.querySelector('[data-host-row] button');
    const nameEl = panel.querySelector('[data-host-name]');
    const idEl = panel.querySelector('[data-host-id-label]');
    const badge = panel.querySelector('[data-host-badge]');
    const chevron = [...panel.querySelectorAll('[data-host-row] span')].find(s => s.textContent.trim() === '▸');
    const btn = panel.querySelector('[data-action="add-host"]');

    const box = (el) => el ? { x: Math.round(el.getBoundingClientRect().x), w: Math.round(el.getBoundingClientRect().width) } : null;

    const rootCs = cs(root);
    return {
      rootPadding: rootCs?.padding,
      rootGap: rootCs?.gap,
      listBg: cs(list)?.backgroundColor,
      listBorderRadius: cs(list)?.borderRadius,
      listBorderWidth: cs(list)?.borderTopWidth,
      headPadding: cs(head)?.padding,
      headDisplay: cs(head)?.display,
      headCols: cs(head)?.gridTemplateColumns,
      rowPadding: cs(firstRow)?.padding,
      rowDisplay: cs(firstRow)?.display,
      rowCols: cs(firstRow)?.gridTemplateColumns,
      // alignment: header label box vs name box vs badge box vs chevron box
      headerLabel: box(panel.querySelector('[data-host-list-head] > span')),
      nameBox: box(nameEl),
      idBox: box(idEl),
      badgeBox: box(badge),
      chevronBox: box(chevron),
      addBtnBox: box(btn),
      pageWidth: Math.round(document.documentElement.getBoundingClientRect().width),
      panelScrollW: panel.scrollWidth,
      panelClientW: panel.clientWidth,
    };
  });
  console.log(JSON.stringify(info, null, 2));

  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
