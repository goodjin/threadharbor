#!/usr/bin/env node
/**
 * 「大象骑自行车」画作结构测试（TDD 红-绿-重构）
 *
 * 运行方式：
 *   node /Users/good/github/threadharbor/elephant-bicycle.test.mjs
 *
 * 约定：作品文件为同目录下的 elephant-bicycle.html。
 * 第一次运行时作品尚不存在，本脚本必须整体失败（红）。
 */

import { readFileSync, existsSync } from 'node:fs';

const HTML_PATH = '/Users/good/github/threadharbor/elephant-bicycle.html';

// ---------- 读取被测文件 ----------
let html = null;
let readError = null;
if (!existsSync(HTML_PATH)) {
  readError = `文件不存在: ${HTML_PATH}`;
} else {
  try {
    html = readFileSync(HTML_PATH, 'utf8');
    if (html.trim().length === 0) readError = '文件存在但内容为空';
  } catch (err) {
    readError = `读取失败: ${err.message}`;
  }
}

// ---------- 极简断言工具（不引入任何测试框架） ----------
const results = [];

function test(name, fn) {
  if (html === null) {
    results.push({ name, ok: false, msg: readError });
    return;
  }
  try {
    const note = fn();
    results.push({ name, ok: true, msg: note || '' });
  } catch (err) {
    results.push({ name, ok: false, msg: err.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 取带指定 id 的完整开标签（不含内容） */
function openTagOf(id) {
  const re = new RegExp(`<[^>]*\\bid="${escapeRe(id)}"[^>]*>`);
  const m = html.match(re);
  assert(m, `缺少 id="${id}" 的元素`);
  return m[0];
}

function hasId(id) {
  return new RegExp(`\\bid="${escapeRe(id)}"`).test(html);
}

function numFrom(tag, re, label) {
  const m = tag.match(re);
  assert(m, `元素缺少可解析的 ${label}: ${tag.slice(0, 90)}`);
  return parseFloat(m[1]);
}

function bodyCenterY() {
  return numFrom(openTagOf('elephant-body'), /cy="(-?[\d.]+)"/, 'cy');
}

function seatPoint() {
  const t = openTagOf('seat');
  return {
    x: numFrom(t, /cx="(-?[\d.]+)"/, 'cx'),
    y: numFrom(t, /cy="(-?[\d.]+)"/, 'cy'),
  };
}

function wheelCenterY(id) {
  const t = openTagOf(id);
  const m = t.match(/translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/);
  assert(m, `${id} 缺少 translate(x y) 定位: ${t.slice(0, 90)}`);
  return parseFloat(m[2]);
}

function firstPointOfPath(id) {
  const t = openTagOf(id);
  const m = t.match(/d="M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/);
  assert(m, `${id} 的路径缺少起始点 M x y: ${t.slice(0, 90)}`);
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

function countOf(re) {
  const m = html.match(re);
  return m ? m.length : 0;
}

/** 简单 XML/HTML 标签良构检查：栈式配对 + 标签内引号成对 */
function checkTagBalance(source) {
  const cleaned = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/i, '');
  const tagRe = /<(\/?)([a-zA-Z][\w:.-]*)([^>]*?)(\/?)>/g;
  const stack = [];
  let m;
  while ((m = tagRe.exec(cleaned)) !== null) {
    const closing = m[1] === '/';
    const name = m[2];
    const selfClosing = m[4] === '/';
    const quotes = (m[0].match(/"/g) || []).length;
    if (quotes % 2 !== 0) return `标签内引号不成对: ${m[0].slice(0, 70)}`;
    if (closing) {
      const top = stack.pop();
      if (top !== name) return `标签不匹配: 期望 </${top}>，实际 </${name}>`;
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  if (stack.length > 0) return `存在未闭合标签: ${stack.join(', ')}`;
  return null;
}

// ============================================================
// 1. 文件与整体结构
// ============================================================

test('作品文件存在且非空', () => {
  assert(html.length > 100, `内容过短（${html.length} 字符），不像完整画作`);
  return `${html.length} 字符`;
});

test('HTML 整体结构完整（doctype/html/head/body/title 及闭合）', () => {
  assert(/^<!DOCTYPE html>/i.test(html), '缺少 <!DOCTYPE html>');
  assert(/<html[\s>]/i.test(html), '缺少 <html>');
  assert(/<\/html>\s*$/i.test(html.trim()), '缺少 </html> 结尾');
  assert(/<head[\s>]/i.test(html), '缺少 <head>');
  assert(/<\/head>/i.test(html), '缺少 </head>');
  assert(/<body[\s>]/i.test(html), '缺少 <body>');
  assert(/<\/body>/i.test(html), '缺少 </body>');
  assert(/<title>[^<]+<\/title>/i.test(html), '缺少 <title> 标题');
});

test('包含内联 <svg> 与 </svg>', () => {
  const opens = countOf(/<svg[\s>]/g);
  assert(opens === 1, `应恰好有 1 个 <svg>，实际 ${opens} 个`);
  assert(countOf(/<\/svg>/g) === 1, '</svg> 数量不为 1');
});

test('标签良构：全部标签配对、无未闭合', () => {
  const err = checkTagBalance(html);
  assert(err === null, err);
});

test('属性引号成对（全文 " 数量为偶数）', () => {
  const quotes = (html.match(/"/g) || []).length;
  assert(quotes % 2 === 0, `引号总数为奇数（${quotes}），属性可能残缺`);
  return `${quotes} 个引号`;
});

test('离线自包含：无任何 http(s) 外链、无位图、无外链资源', () => {
  assert(!/https?:\/\//i.test(html), '出现了 http:// 或 https:// 外链');
  assert(!/<img\b/i.test(html), '出现了 <img> 位图标签');
  assert(!/<link\b/i.test(html), '出现了 <link> 外部样式表');
  assert(!/\bhref\s*=/i.test(html), '出现了 href 属性');
  assert(!/\bsrc\s*=/i.test(html), '出现了 src 属性');
});

test('样式内联在 <style> 中', () => {
  assert(/<style[\s>]/i.test(html), '缺少内联 <style>');
});

// ============================================================
// 2. 大象部件
// ============================================================

test('大象身体 elephant-body 存在且有中心坐标', () => {
  const t = openTagOf('elephant-body');
  numFrom(t, /cx="(-?[\d.]+)"/, 'cx');
  numFrom(t, /cy="(-?[\d.]+)"/, 'cy');
});

test('大象头 elephant-head 存在', () => openTagOf('elephant-head'));

test('大耳朵 elephant-ear 存在', () => {
  const n = countOf(/id="elephant-ear[^"]*"/g);
  assert(n >= 1, '未找到 id 以 elephant-ear 开头的耳朵元素');
  return `${n} 只耳朵`;
});

test('鼻子 elephant-trunk 存在', () => openTagOf('elephant-trunk'));

test('象牙 elephant-tusk 存在', () => {
  const n = countOf(/id="elephant-tusk[^"]*"/g);
  assert(n >= 1, '未找到 id 以 elephant-tusk 开头的象牙元素');
  return `${n} 根象牙`;
});

test('四条腿（class="leg" 恰好 4 条）', () => {
  const n = countOf(/class="[^"]*\bleg\b[^"]*"/g);
  assert(n === 4, `class 含 leg 的元素应为 4，实际 ${n}`);
});

test('前腿与后腿分别命名（front/rear）', () => {
  assert(countOf(/id="leg-front[^"]*"/g) >= 1, '缺少前腿 leg-front-*');
  assert(countOf(/id="leg-rear[^"]*"/g) >= 1, '缺少后腿 leg-rear-*');
});

// ============================================================
// 3. 自行车部件
// ============================================================

test('后轮 wheel-rear 存在且可定位', () => wheelCenterY('wheel-rear'));

test('前轮 wheel-front 存在且可定位', () => wheelCenterY('wheel-front'));

test('车架 bike-frame 存在', () => openTagOf('bike-frame'));

test('车把 handlebar 存在', () => openTagOf('handlebar'));

test('鞍座 seat 存在且有中心坐标', () => seatPoint());

test('车链 bike-chain 存在', () => openTagOf('bike-chain'));

// ============================================================
// 4. 构图关系
// ============================================================

test('大象在自行车上方（身体中心 y 明显小于车轮中心 y）', () => {
  const bodyY = bodyCenterY();
  const rearY = wheelCenterY('wheel-rear');
  const frontY = wheelCenterY('wheel-front');
  assert(bodyY < rearY - 40, `身体中心 y=${bodyY} 未明显高于后轮 y=${rearY}`);
  assert(bodyY < frontY - 40, `身体中心 y=${bodyY} 未明显高于前轮 y=${frontY}`);
  return `body.y=${bodyY} < wheels.y=${rearY}/${frontY}`;
});

test('坐姿关系：身体在座上、座在轮上方（body.y < seat.y < wheel.y）', () => {
  const bodyY = bodyCenterY();
  const seatY = seatPoint().y;
  const wheelY = wheelCenterY('wheel-rear');
  assert(bodyY < seatY, `身体 y=${bodyY} 应在座 y=${seatY} 上方`);
  assert(seatY < wheelY - 40, `座 y=${seatY} 应明显高于车轮 y=${wheelY}`);
  return `body.y=${bodyY} < seat.y=${seatY} < wheel.y=${wheelY}`;
});

test('座位于后腿起始点附近（屁股坐在鞍座上）', () => {
  const seat = seatPoint();
  const hip = firstPointOfPath('leg-rear-left');
  const dist = Math.hypot(hip.x - seat.x, hip.y - seat.y);
  assert(dist <= 60, `后腿起点 (${hip.x},${hip.y}) 距座 (${seat.x},${seat.y}) ${dist.toFixed(1)}px，超出 60px`);
  return `距离 ${dist.toFixed(1)}px`;
});

test('两个车轮都在地面之上且同高', () => {
  const rear = wheelCenterY('wheel-rear');
  const front = wheelCenterY('wheel-front');
  assert(Math.abs(rear - front) < 5, `两轮中心 y 不同高: ${rear} vs ${front}`);
  return `轮心 y=${rear}`;
});

// ============================================================
// 5. 细节与背景
// ============================================================

test('车轮有辐条（class="spoke" ≥ 10 根）', () => {
  const n = countOf(/class="[^"]*\bspoke\b[^"]*"/g);
  assert(n >= 10, `辐条应 ≥ 10，实际 ${n}`);
  return `${n} 根辐条`;
});

test('地面与阴影存在', () => {
  assert(hasId('ground'), '缺少 id="ground" 地面');
  assert(hasId('ground-shadow'), '缺少 id="ground-shadow" 阴影');
});

test('动感元素：速度线 ≥ 2 条', () => {
  const n = countOf(/class="[^"]*speed-line[^"]*"/g);
  assert(n >= 2, `速度线应 ≥ 2，实际 ${n}`);
  return `${n} 条`;
});

test('背景：天空存在，且有太阳或云', () => {
  assert(hasId('sky'), '缺少 id="sky" 天空');
  assert(hasId('sun') || countOf(/id="cloud[^"]*"/g) > 0, '太阳和云至少要有一个');
});

test('标题文字 <text> 存在且非空', () => {
  const m = html.match(/<text[^>]*>([^<]{1,})<\/text>/);
  assert(m, '未找到带文字内容的 <text> 元素');
  return `标题: ${m[1].trim()}`;
});

// ---------- 汇总输出 ----------
console.log('=== 大象骑自行车 · 结构测试 ===');
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${r.name}${r.msg ? ` — ${r.msg}` : ''}`);
}
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`---\n通过 ${passed} / ${results.length}，失败 ${failed}`);
if (failed > 0) process.exit(1);
console.log('全部通过 ✅');
