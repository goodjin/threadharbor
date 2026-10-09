import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildScene } from './sunrise-geometry.js';

const VIEW = { width: 1600, height: 900 };

describe('太阳几何', () => {
  test('太阳圆心在画面水平方向居中', () => {
    const scene = buildScene({ ...VIEW });
    assert.ok(Math.abs(scene.sun.cx - VIEW.width / 2) < 1e-9);
  });

  test('太阳圆心落在地平线之上或紧贴地平线', () => {
    const scene = buildScene({ ...VIEW });
    assert.ok(scene.sun.cy <= scene.horizon.y, `太阳圆心 ${scene.sun.cy} 应不高于地平线 ${scene.horizon.y} 之下方`);
  });

  test('太阳整体不越出画面上下边界（圆盘顶部在画面内）', () => {
    const scene = buildScene({ ...VIEW });
    assert.ok(scene.sun.cy - scene.sun.r >= 0, '太阳顶边超出画面');
    assert.ok(scene.sun.cy + scene.sun.r <= VIEW.height, '太阳底边超出画面');
  });
});

describe('地平线几何', () => {
  test('地平线 y 等于 height × horizonRatio（线性）', () => {
    const a = buildScene({ width: 1000, height: 800, horizonRatio: 0.6 });
    const b = buildScene({ width: 1000, height: 800, horizonRatio: 0.8 });
    assert.equal(a.horizon.y, 480);
    assert.equal(b.horizon.y, 640);
    // 线性：ratio 增量相同 → y 增量相同
    assert.ok(Math.abs((b.horizon.y - a.horizon.y) - (640 - 480)) < 1e-9);
  });

  test('合法 horizonRatio 下地平线严格落在画面内部', () => {
    for (const ratio of [0.1, 0.5, 0.62, 0.9]) {
      const scene = buildScene({ width: 1200, height: 600, horizonRatio: ratio });
      assert.ok(scene.horizon.y > 0 && scene.horizon.y < 600);
    }
  });
});

describe('太阳尺寸', () => {
  test('太阳半径大于 0 且小于画面宽度的 15%', () => {
    const scene = buildScene({ ...VIEW });
    assert.ok(scene.sun.r > 0);
    assert.ok(scene.sun.r < VIEW.width * 0.15);
  });
});

describe('输入校验', () => {
  test('width 为 0 或负数时抛出错误', () => {
    assert.throws(() => buildScene({ width: 0, height: 900 }), Error);
    assert.throws(() => buildScene({ width: -100, height: 900 }), Error);
  });

  test('height 为 0 或负数时抛出错误', () => {
    assert.throws(() => buildScene({ width: 1600, height: 0 }), Error);
    assert.throws(() => buildScene({ width: 1600, height: -1 }), Error);
  });

  test('horizonRatio 超出 (0,1) 时抛出错误', () => {
    assert.throws(() => buildScene({ ...VIEW, horizonRatio: 0 }), Error);
    assert.throws(() => buildScene({ ...VIEW, horizonRatio: 1 }), Error);
    assert.throws(() => buildScene({ ...VIEW, horizonRatio: 1.5 }), Error);
  });

  test('非有限数值（NaN / Infinity）抛出错误', () => {
    assert.throws(() => buildScene({ width: NaN, height: 900 }), Error);
    assert.throws(() => buildScene({ width: Infinity, height: 900 }), Error);
  });
});

describe('图元完整性', () => {
  test('场景核心图元齐全且无 NaN / undefined', () => {
    const scene = buildScene({ ...VIEW });
    for (const key of ['width', 'height', 'horizon', 'sun', 'skyGradient']) {
      assert.ok(scene[key] !== undefined, `缺少图元 ${key}`);
    }
  });

  test('所有数值坐标都是有限数且落在视口范围内', () => {
    const scene = buildScene({ ...VIEW });
    const numbers = [scene.horizon.y, scene.sun.cx, scene.sun.cy, scene.sun.r];
    for (const n of numbers) {
      assert.equal(typeof n, 'number');
      assert.ok(Number.isFinite(n), `坐标 ${n} 不是有限数`);
    }
    assert.ok(scene.horizon.y >= 0 && scene.horizon.y <= VIEW.height);
    assert.ok(scene.sun.cx >= 0 && scene.sun.cx <= VIEW.width);
    assert.ok(scene.sun.cy >= 0 && scene.sun.cy <= VIEW.height);
  });
});
