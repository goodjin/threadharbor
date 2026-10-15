import { chromium } from '/Users/good/claude/skills/content-collector/scripts/node_modules/playwright-core/index.mjs'

const TOKEN = process.argv[2]
const BASE = 'http://127.0.0.1:3081'

const launch = () => chromium.launch({
  headless: true,
  executablePath: '/Users/good/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--no-proxy-server', '--proxy-bypass-list=127.0.0.1;localhost;<local>'],
})

const visibleText = page => page.evaluate(() =>
  [...document.querySelectorAll('button, [role="menuitem"], [role="option"], [role="combobox"], [role="listbox"] [role="option"]')]
    .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 0 && t.length < 80))

;(async () => {
  const browser = await launch()
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(9000)

  // The new-task screen's preset chip opens the roster. Click whatever names the
  // current default preset, then read the menu it opens.
  const chipCandidates = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter(b => /standard|superpowers|preset|预设/i.test(b.textContent || ''))
      .map(b => (b.textContent || '').replace(/\s+/g, ' ').trim()))
  console.log('CHIP_CANDIDATES:', JSON.stringify(chipCandidates))

  const clicked = await page.evaluate(() => {
    const all = [...document.querySelectorAll('button, [role="combobox"], [tabindex]')]
    const b = all.find(x => /标准模式|Standard/i.test(x.textContent || '') && (x.textContent || '').length < 40)
    if (!b) return false
    b.click()
    return (b.textContent || '').trim()
  })
  console.log('CLICKED_CHIP:', JSON.stringify(clicked))
  await page.waitForTimeout(1500)

  const menuText = await page.evaluate(() => {
    const lists = [...document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]')]
    if (lists.length === 0) return []
    return lists.map(root => [...root.querySelectorAll('[role="menuitem"], [role="option"], button, div')]
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 0 && t.length < 120))
  })
  console.log('PRESET_MENU:', JSON.stringify(menuText, null, 1))
  await page.screenshot({ path: '/tmp/3081-preset-menu.png' })

  // The composer's model picker: click the model chip (names a provider/model).
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  const modelChip = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /claude|grok|codex|cursor|gpt|glm|minimax|mimo|deepseek|opus/i.test(x.textContent || ''))
    if (!b) return null
    const label = (b.textContent || '').replace(/\s+/g, ' ').trim()
    b.click()
    return label
  })
  console.log('MODEL_CHIP:', JSON.stringify(modelChip))
  await page.waitForTimeout(1500)
  const modelMenu = await page.evaluate(() => {
    const hits = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="group"], button, li, span, div')]
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 0 && t.length < 100
        && /codex|claude|grok|cursor|gpt-|glm|minimax|mimo|deepseek|opus|sonnet|haiku|fable|Default|default|模型|全部|切换/i.test(t))
    return [...new Set(hits)]
  })
  console.log('MODEL_POPOVER:', JSON.stringify(modelMenu, null, 1))

  // Dig into the full catalog: the "模型" row in the popover opens the list.
  const dug = await page.evaluate(() => {
    const walker = [...document.querySelectorAll('body *')]
    const el = walker.find(x => (x.textContent || '').trim() === '模型')
    if (!el) return { found: false }
    let clickable = el
    for (let i = 0; i < 4 && clickable; i++) {
      clickable.click?.()
      clickable = clickable.parentElement
    }
    return { found: true }
  })
  console.log('DUG_INTO:', JSON.stringify(dug))
  await page.waitForTimeout(1200)
  const fullMenu = await page.evaluate(() => {
    const hits = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="group"], button, li, span, div')]
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 0 && t.length < 100
        && /codex|claude|grok|cursor|gpt-|glm|minimax|mimo|deepseek|opus|sonnet|haiku|fable/i.test(t))
    return [...new Set(hits)]
  })
  console.log('MODEL_FULL:', JSON.stringify(fullMenu, null, 1))

  await page.screenshot({ path: '/tmp/3081-newtask.png' })
  await browser.close()
})().catch(e => { console.error('ERR', e); process.exit(1) })
