const { test, mock } = require('node:test');
const assert = require('node:assert');
const { normalizeOptions } = require('../lib/config');

function silenceWarn(fn) {
  const warn = mock.method(console, 'warn', () => {});
  try {
    return { result: fn(), warn };
  } finally {
    warn.mock.restore();
  }
}

test('新格式 {roots:[{root,include}]} 归一化（去尾斜杠、去 .js 后缀）', () => {
  const cfg = normalizeOptions({
    roots: [{ root: 'mp_ecard_sdk/protocol/', include: ['mp_ecard_sdk/protocol/sdk.js'] }],
  });
  assert.deepStrictEqual(cfg.roots, [
    { root: 'mp_ecard_sdk/protocol', include: ['mp_ecard_sdk/protocol/sdk'] },
  ]);
});

test('Windows 反斜杠路径归一化', () => {
  const cfg = normalizeOptions({
    roots: [{ root: 'pages\\biz-vendor', include: ['pages\\biz-vendor\\request'] }],
  });
  assert.deepStrictEqual(cfg.roots, [
    { root: 'pages/biz-vendor', include: ['pages/biz-vendor/request'] },
  ]);
});

test('旧数组格式归一化为新格式（root 取前两段）并打印弃用警告', () => {
  const { result: cfg, warn } = silenceWarn(() =>
    normalizeOptions([
      'pages/biz-vendor/request',
      'pages/biz-vendor/im-sdk',
      'mp_ecard_sdk/protocol/sdk',
    ])
  );
  assert.deepStrictEqual(cfg.roots, [
    { root: 'pages/biz-vendor', include: ['pages/biz-vendor/request', 'pages/biz-vendor/im-sdk'] },
    { root: 'mp_ecard_sdk/protocol', include: ['mp_ecard_sdk/protocol/sdk'] },
  ]);
  assert.ok(warn.mock.calls.length >= 1, '应打印弃用警告');
});

test('{roots: [字符串...]} 同样按旧格式兼容处理', () => {
  const { result: cfg } = silenceWarn(() =>
    normalizeOptions({ roots: ['pages/biz-vendor/request'] })
  );
  assert.deepStrictEqual(cfg.roots, [
    { root: 'pages/biz-vendor', include: ['pages/biz-vendor/request'] },
  ]);
});

test('include 不在 root 之下时报错', () => {
  assert.throws(
    () => normalizeOptions({ roots: [{ root: 'pages/a', include: ['pages/b/x'] }] }),
    /include/
  );
});

test('include 路径边界：root pages/biz 不得包含 pages/biz-vendor/x', () => {
  assert.throws(() =>
    normalizeOptions({ roots: [{ root: 'pages/biz', include: ['pages/biz-vendor/x'] }] })
  );
});

test('缺参 / 非法类型 / 空 roots 一律 fail-fast', () => {
  assert.throws(() => normalizeOptions(undefined));
  assert.throws(() => normalizeOptions(null));
  assert.throws(() => normalizeOptions('pages/a/b'));
  assert.throws(() => normalizeOptions({}));
  assert.throws(() => normalizeOptions([]));
  assert.throws(() => normalizeOptions({ roots: [] }));
  assert.throws(() => normalizeOptions({ roots: [{ root: 'pages/a' }] })); // 缺 include
  assert.throws(() => normalizeOptions({ roots: [{ root: '', include: ['x'] }] }));
});

test('roots 混用字符串与对象条目报错', () => {
  silenceWarn(() => {
    assert.throws(() =>
      normalizeOptions({ roots: ['pages/a/b', { root: 'pages/c', include: ['pages/c/d'] }] })
    );
  });
});

test('旧数组条目不足两段时报错', () => {
  silenceWarn(() => {
    assert.throws(() => normalizeOptions(['vendor']), /两段/);
  });
});

test('同一 root 重复声明时合并 include 并去重（不再静默覆盖）', () => {
  const cfg = normalizeOptions({
    roots: [
      { root: 'pages/v', include: ['pages/v/a'] },
      { root: 'pages/v', include: ['pages/v/b', 'pages/v/a'] },
    ],
  });
  assert.deepStrictEqual(cfg.roots, [{ root: 'pages/v', include: ['pages/v/a', 'pages/v/b'] }]);
});

test('嵌套 root 直接拒绝（微信不允许分包根目录相互嵌套）', () => {
  assert.throws(
    () =>
      normalizeOptions({
        roots: [
          { root: 'packageA', include: ['packageA/x'] },
          { root: 'packageA/nested', include: ['packageA/nested/y'] },
        ],
      }),
    /嵌套/
  );
  // 路径边界：packageA 与 packageA-extra 不构成嵌套
  assert.doesNotThrow(() =>
    normalizeOptions({
      roots: [
        { root: 'packageA', include: ['packageA/x'] },
        { root: 'packageA-extra', include: ['packageA-extra/y'] },
      ],
    })
  );
});
