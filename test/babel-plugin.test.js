const { test, mock } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { transformSync } = require('@babel/core');
const plugin = require('../babel/babel-plugin-async-wrapper');

// Babel 插件与 Webpack 插件同样只在小程序平台生效
process.env.UNI_PLATFORM = 'mp-weixin';

const ROOTS = [
  { root: 'pages/biz-vendor', include: ['pages/biz-vendor/request'] },
  { root: 'mp_ecard_sdk/protocol', include: ['mp_ecard_sdk/protocol/sdk'] },
];

function run(code, { filename, inputDir, roots = ROOTS }) {
  return transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    plugins: [[plugin, { roots, inputDir }]],
  }).code;
}

test('基本转换：相对路径锚定 inputDir，require 保留去 query 的原始路径', () => {
  const out = run(
    `import('@/pages/biz-vendor/request.js?root=pages/biz-vendor').then(m => m.getData());`,
    { filename: '/proj/src/pages/biz/index/index.vue', inputDir: '/proj/src' }
  );
  assert.match(
    out,
    /__non_webpack_require__\.async\("\.\.\/\.\.\/biz-vendor\/common\/vendor\.js"\)/
  );
  assert.match(out, /require\("@\/pages\/biz-vendor\/request\.js"\)/);
  assert.ok(!out.includes('?root='), '产物中不应残留 ?root= 查询参数');
});

test('任意 root（非 pages/ 前缀、与引用方非兄弟目录）', () => {
  const out = run(`import('@/mp_ecard_sdk/protocol/sdk.js?root=mp_ecard_sdk/protocol')`, {
    filename: '/proj/src/pages/biz/index/index.vue',
    inputDir: '/proj/src',
  });
  assert.match(
    out,
    /__non_webpack_require__\.async\("\.\.\/\.\.\/\.\.\/mp_ecard_sdk\/protocol\/common\/vendor\.js"\)/
  );
});

test('inputDir 根下的文件（无需上跳）', () => {
  const out = run(`import('@/pages/biz-vendor/request.js?root=pages/biz-vendor')`, {
    filename: '/proj/src/main.js',
    inputDir: '/proj/src',
  });
  assert.match(out, /__non_webpack_require__\.async\("pages\/biz-vendor\/common\/vendor\.js"\)/);
});

test('项目绝对路径中含 pages 段不干扰（锚定 inputDir 而非猜段）', () => {
  const out = run(`import('@/pages/biz-vendor/request.js?root=pages/biz-vendor')`, {
    filename: '/Users/x/pages-app/src/pages/biz/index/index.vue',
    inputDir: '/Users/x/pages-app/src',
  });
  assert.match(
    out,
    /__non_webpack_require__\.async\("\.\.\/\.\.\/biz-vendor\/common\/vendor\.js"\)/
  );
});

test('Windows 风格路径（直接单测纯函数：babel 在 posix 主机会把 C:\\ 路径按相对路径拼 cwd，无法端到端模拟）', () => {
  const { computeVendorPath } = plugin;
  assert.strictEqual(
    computeVendorPath(
      'C:\\proj\\src\\pages\\biz\\index\\index.vue',
      'C:\\proj\\src',
      'pages/biz-vendor'
    ),
    '../../biz-vendor/common/vendor.js'
  );
});

test('fail-fast：?root= 的值未在 roots 配置中 → 抛错（不再静默继续）', () => {
  assert.throws(
    () =>
      run(`import('@/x.js?root=pages/unknown')`, {
        filename: '/proj/src/a.js',
        inputDir: '/proj/src',
      }),
    /pages\/unknown/
  );
});

test('fail-fast：当前文件不在 inputDir 之下 → 抛错（不再 fallback 猜路径）', () => {
  assert.throws(
    () =>
      run(`import('@/pages/biz-vendor/request.js?root=pages/biz-vendor')`, {
        filename: '/elsewhere/a.js',
        inputDir: '/proj/src',
      }),
    /源码根目录|inputDir/
  );
});

test('无 ?root= 的动态 import 保持原样', () => {
  const out = run(`import('@/pages/biz/other.js').then(() => {});`, {
    filename: '/proj/src/a.js',
    inputDir: '/proj/src',
  });
  assert.ok(/import\(['"]@\/pages\/biz\/other\.js['"]\)/.test(out), '普通动态 import 不应被改写');
});

test('非小程序平台（如 h5）不做任何改写', () => {
  const prev = process.env.UNI_PLATFORM;
  process.env.UNI_PLATFORM = 'h5';
  try {
    const out = run(`import('@/pages/biz-vendor/request.js?root=pages/biz-vendor')`, {
      filename: '/proj/src/a.js',
      inputDir: '/proj/src',
    });
    assert.ok(
      !out.includes('__non_webpack_require__'),
      'H5/App 构建不得产出 __non_webpack_require__.async（运行时不存在，会崩）'
    );
    assert.ok(out.includes('?root='), 'H5 构建应保留原始 import 不动');
  } finally {
    process.env.UNI_PLATFORM = prev;
  }
});

test('inputDir 传相对路径时按 process.cwd() 解析', () => {
  const relInput = 'test/fixtures/demo/src';
  const filename = path.join(process.cwd(), relInput, 'pages/biz/index/index.vue');
  const out = run(`import('@/pages/biz-vendor/request.js?root=pages/biz-vendor')`, {
    filename,
    inputDir: relInput,
  });
  assert.match(out, /\.\.\/\.\.\/biz-vendor\/common\/vendor\.js/);
});

test('旧数组 roots 在 Babel 侧同样可用（共享同一份配置契约）', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const out = run(`import('@/pages/biz-vendor/request.js?root=pages/biz-vendor')`, {
      filename: '/proj/src/pages/biz/index/index.vue',
      inputDir: '/proj/src',
      roots: ['pages/biz-vendor/request'],
    });
    assert.match(out, /\.\.\/\.\.\/biz-vendor\/common\/vendor\.js/);
  } finally {
    warn.mock.restore();
  }
});
