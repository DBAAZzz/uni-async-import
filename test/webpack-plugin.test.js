require('./helpers/patch-md4');

const { test, mock } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const webpack = require('webpack');
const AsyncImportPlugin = require('../webpack');
const babelPlugin = require('../babel/babel-plugin-async-wrapper');

const FIXTURE_SRC = path.join(__dirname, 'fixtures/demo/src');
const PAGES_JSON = path.join(FIXTURE_SRC, 'pages.json');
const ROOTS = [
  { root: 'pages/biz-vendor', include: ['pages/biz-vendor/request'] },
  { root: 'mp_ecard_sdk/protocol', include: ['mp_ecard_sdk/protocol/sdk'] },
];
const ENTRIES = {
  'pages/tabbar/home/index': './pages/tabbar/home/index.js',
  'pages/biz/index/index': './pages/biz/index/index.js',
};

function makeConfig({ plugin, entry, outDir, commonsTest }) {
  return {
    mode: 'development',
    devtool: false,
    context: FIXTURE_SRC,
    entry,
    output: {
      path: outDir,
      filename: '[name].js',
      jsonpFunction: 'webpackJsonp',
      globalObject: 'this',
    },
    resolve: { alias: { '@': FIXTURE_SRC } },
    module: {
      rules: [
        {
          test: /\.js$/,
          use: {
            loader: 'babel-loader',
            options: {
              babelrc: false,
              configFile: false,
              plugins: [[babelPlugin, { roots: ROOTS, inputDir: FIXTURE_SRC }]],
            },
          },
        },
      ],
    },
    optimization: {
      runtimeChunk: { name: 'common/runtime' },
      splitChunks: {
        minSize: 0,
        cacheGroups: {
          // 模拟 uni-app 的 commons cacheGroup
          commons: {
            test: commonsTest !== undefined ? commonsTest : (module) => !!module.resource,
            name: 'common/vendor',
            chunks: 'all',
            minChunks: 2,
            priority: 10,
          },
        },
      },
    },
    plugins: [plugin],
  };
}

function compile(config) {
  return new Promise((resolve, reject) => {
    webpack(config).run((err, stats) => (err ? reject(err) : resolve(stats)));
  });
}

function mkOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uni-async-import-'));
}

function read(outDir, rel) {
  return fs.readFileSync(path.join(outDir, rel), 'utf8');
}

const ASYNC_CALL = (relPath) =>
  new RegExp(
    `(?:__non_webpack_require__|require)\\.async\\("${relPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"\\)`
  );

test('集成：vendor 落位 / require.async 相对路径 / 依赖数组清理', async () => {
  process.env.UNI_PLATFORM = 'mp-weixin';
  const outDir = mkOut();
  const plugin = new AsyncImportPlugin({
    roots: ROOTS,
    pagesJsonPath: PAGES_JSON,
    inputDir: FIXTURE_SRC,
  });
  const stats = await compile(makeConfig({ plugin, entry: ENTRIES, outDir }));
  assert.ok(!stats.hasErrors(), stats.toString({ errors: true }));

  // 1. vendor chunk 落位正确且只含 include 的模块
  const bizVendor = read(outDir, 'pages/biz-vendor/common/vendor.js');
  assert.ok(
    bizVendor.includes('BIZ_VENDOR_REQUEST'),
    'request.js 应进入 biz-vendor 的 vendor chunk'
  );
  assert.ok(
    !bizVendor.includes('REQUEST_HELPER'),
    'request-helper 不在 include 中，不得混入 vendor'
  );
  const ecardVendor = read(outDir, 'mp_ecard_sdk/protocol/common/vendor.js');
  assert.ok(ecardVendor.includes('ECARD_SDK'), '非 pages/ 前缀的任意 root 也应正确落位');

  // 2. commons 不吞 vendor 模块
  const commons = read(outDir, 'common/vendor.js');
  assert.ok(commons.includes('COMMON_HELPER'), '公共 helper 应留在 commons');
  assert.ok(!commons.includes('BIZ_VENDOR_REQUEST'), 'vendor 模块不得进入 commons');

  // 2b. P0-3 回归：业务代码中与 vendor chunk 同名的字符串字面量不得被破坏
  assert.match(
    commons,
    /["']pages\/biz-vendor\/common\/vendor["']/,
    '与 chunk 名相同的业务字符串字面量必须原样保留（emit 字符串手术会误删它）'
  );

  // 3. require.async 相对路径正确（锚定产物位置）
  const biz = read(outDir, 'pages/biz/index/index.js');
  assert.match(biz, ASYNC_CALL('../../biz-vendor/common/vendor.js'));
  assert.match(biz, ASYNC_CALL('../../../mp_ecard_sdk/protocol/common/vendor.js'));

  // 4. 入口 chunk 依赖数组中 vendor 已被清理，且未误删 commons / 自身条目
  assert.ok(!biz.includes('"pages/biz-vendor/common/vendor"'), 'biz 入口依赖数组应清理 vendor');
  assert.ok(
    !biz.includes('"mp_ecard_sdk/protocol/common/vendor"'),
    'biz 入口依赖数组应清理 sdk vendor'
  );
  assert.ok(biz.includes('"common/vendor"'), '不得误删 commons 依赖');
  const home = read(outDir, 'pages/tabbar/home/index.js');
  assert.ok(home.includes('"common/vendor"'), '不得误删 commons 依赖');
  assert.match(home, ASYNC_CALL('../../biz-vendor/common/vendor.js'));
  assert.ok(
    !home.includes('"pages/biz-vendor/common/vendor"'),
    '多个入口引用同一 vendor 时应全部清理（修复 indexOf 只删第一处的 bug）'
  );

  // 5. vendor chunk 自身的 webpackJsonp 注册头不得被清理
  assert.ok(
    bizVendor.includes('"pages/biz-vendor/common/vendor"'),
    'vendor chunk 自身的 chunk id 注册不得被误删'
  );
});

test('集成（兼容模式）：旧数组配置产出相同 vendor 落位', async () => {
  process.env.UNI_PLATFORM = 'mp-weixin';
  process.env.UNI_INPUT_DIR = FIXTURE_SRC;
  const warn = mock.method(console, 'warn', () => {});
  try {
    const outDir = mkOut();
    const plugin = new AsyncImportPlugin(['pages/biz-vendor/request', 'mp_ecard_sdk/protocol/sdk']);
    const stats = await compile(makeConfig({ plugin, entry: ENTRIES, outDir }));
    assert.ok(!stats.hasErrors(), stats.toString({ errors: true }));
    assert.ok(fs.existsSync(path.join(outDir, 'pages/biz-vendor/common/vendor.js')));
    assert.ok(fs.existsSync(path.join(outDir, 'mp_ecard_sdk/protocol/common/vendor.js')));
    assert.ok(warn.mock.calls.length >= 1, '兼容模式应打印弃用警告');
  } finally {
    warn.mock.restore();
    delete process.env.UNI_INPUT_DIR;
  }
});

test('fail-fast：配置的 root 未在 pages.json 声明 → 构建启动即报错', () => {
  process.env.UNI_PLATFORM = 'mp-weixin';
  const plugin = new AsyncImportPlugin({
    roots: [{ root: 'pages/not-declared', include: ['pages/not-declared/x'] }],
    pagesJsonPath: PAGES_JSON,
    inputDir: FIXTURE_SRC,
  });
  assert.throws(
    () => webpack(makeConfig({ plugin, entry: ENTRIES, outDir: mkOut() })),
    /not-declared/
  );
});

test('fail-fast：业务代码 ?root= 未在配置中 → 编译失败并指出该 root', async () => {
  process.env.UNI_PLATFORM = 'mp-weixin';
  const outDir = mkOut();
  const plugin = new AsyncImportPlugin({
    roots: ROOTS,
    pagesJsonPath: PAGES_JSON,
    inputDir: FIXTURE_SRC,
  });
  const stats = await compile(
    makeConfig({ plugin, entry: { 'pages/biz/bad': './pages/biz/bad.js' }, outDir })
  );
  assert.ok(stats.hasErrors(), '应产生编译错误而不是静默通过');
  const errors = stats.toJson({ errors: true }).errors.map(String).join('\n');
  assert.ok(errors.includes('pages/unknown'), `错误信息应包含未声明的 root，实际: ${errors}`);
});

test('fail-fast：构造函数缺参即抛错', () => {
  assert.throws(() => new AsyncImportPlugin());
  assert.throws(() => new AsyncImportPlugin({}));
});

test('fail-fast：?root= 已被使用但 include 未命中任何模块 → 构建失败（而非告警）', async () => {
  process.env.UNI_PLATFORM = 'mp-weixin';
  const outDir = mkOut();
  const plugin = new AsyncImportPlugin({
    roots: [{ root: 'pages/biz-vendor', include: ['pages/biz-vendor/nonexistent'] }],
    pagesJsonPath: PAGES_JSON,
    inputDir: FIXTURE_SRC,
  });
  const stats = await compile(
    makeConfig({
      plugin,
      entry: { 'pages/tabbar/home/index': './pages/tabbar/home/index.js' },
      outDir,
    })
  );
  assert.ok(stats.hasErrors(), 'vendor chunk 未产出且 root 已被使用时必须构建失败，否则运行时 404');
  const errors = stats.toJson({ errors: true }).errors.map(String).join('\n');
  assert.ok(errors.includes('pages/biz-vendor'), `错误信息应包含 root，实际: ${errors}`);
});

test('未被业务代码使用的配置 root 未产出 chunk 时仅告警；inputDir 相对路径按 context 解析', async () => {
  process.env.UNI_PLATFORM = 'mp-weixin';
  const warn = mock.method(console, 'warn', () => {});
  try {
    const outDir = mkOut();
    const plugin = new AsyncImportPlugin({
      roots: ROOTS,
      pagesJsonPath: PAGES_JSON,
      // 相对路径，应按 compiler.context（= FIXTURE_SRC）解析
      inputDir: '.',
    });
    // 入口只使用 pages/biz-vendor；mp_ecard_sdk/protocol 是未使用的死配置
    const stats = await compile(
      makeConfig({
        plugin,
        entry: { 'pages/tabbar/home/index': './pages/tabbar/home/index.js' },
        outDir,
      })
    );
    assert.ok(!stats.hasErrors(), stats.toString({ errors: true }));
    assert.ok(
      fs.existsSync(path.join(outDir, 'pages/biz-vendor/common/vendor.js')),
      '相对 inputDir 解析正确时 vendor chunk 应正常产出'
    );
    const warned = warn.mock.calls.some((c) =>
      String(c.arguments[0]).includes('mp_ecard_sdk/protocol/common/vendor')
    );
    assert.ok(warned, '未使用的死配置应告警而非报错');
  } finally {
    warn.mock.restore();
  }
});

test('fail-fast：Babel 与 Webpack 配置不一致（Babel 转换了 Webpack 未配置的 root）→ 构建失败', async () => {
  process.env.UNI_PLATFORM = 'mp-weixin';
  const outDir = mkOut();
  // babel-loader 用完整 ROOTS，webpack 插件只配了 biz-vendor —— 模拟两处配置漂移
  const plugin = new AsyncImportPlugin({
    roots: [{ root: 'pages/biz-vendor', include: ['pages/biz-vendor/request'] }],
    pagesJsonPath: PAGES_JSON,
    inputDir: FIXTURE_SRC,
  });
  const stats = await compile(
    makeConfig({ plugin, entry: { 'pages/biz/index/index': './pages/biz/index/index.js' }, outDir })
  );
  assert.ok(stats.hasErrors(), '配置漂移必须在构建期失败，而不是运行时 404');
  const errors = stats.toJson({ errors: true }).errors.map(String).join('\n');
  assert.ok(errors.includes('mp_ecard_sdk/protocol'), `错误信息应指出漂移的 root，实际: ${errors}`);
});

test('commons.test 非函数形态：string 语义保留；boolean 被 webpack 4 schema 直接拒绝', async () => {
  process.env.UNI_PLATFORM = 'mp-weixin';

  // string 形态（schema 合法）：包装后语义保留
  const outDir = mkOut();
  const plugin = new AsyncImportPlugin({
    roots: ROOTS,
    pagesJsonPath: PAGES_JSON,
    inputDir: FIXTURE_SRC,
  });
  const stats = await compile(
    makeConfig({ plugin, entry: ENTRIES, outDir, commonsTest: FIXTURE_SRC })
  );
  assert.ok(!stats.hasErrors(), stats.toString({ errors: true }));
  const commons = read(outDir, 'common/vendor.js');
  assert.ok(commons.includes('COMMON_HELPER'), 'test: <string> 应保持 commons 正常工作');
  assert.ok(!commons.includes('BIZ_VENDOR_REQUEST'), 'vendor 模块仍需被排除');

  // boolean 形态：webpack 4 配置校验发生在插件 apply 之前，schema 只允许
  // function/string/RegExp —— boolean 根本到不了插件的包装函数
  const plugin2 = new AsyncImportPlugin({
    roots: ROOTS,
    pagesJsonPath: PAGES_JSON,
    inputDir: FIXTURE_SRC,
  });
  assert.throws(
    () =>
      webpack(makeConfig({ plugin: plugin2, entry: ENTRIES, outDir: mkOut(), commonsTest: true })),
    /splitChunks/
  );
});

test('非小程序平台：插件不生效，不产出 vendor chunk', async () => {
  delete process.env.UNI_PLATFORM;
  delete process.env.VUE_APP_PLATFORM;
  const log = mock.method(console, 'log', () => {});
  try {
    const outDir = mkOut();
    const plugin = new AsyncImportPlugin({
      roots: ROOTS,
      pagesJsonPath: PAGES_JSON,
      inputDir: FIXTURE_SRC,
    });
    const stats = await compile(makeConfig({ plugin, entry: ENTRIES, outDir }));
    assert.ok(!stats.hasErrors(), stats.toString({ errors: true }));
    assert.ok(!fs.existsSync(path.join(outDir, 'pages/biz-vendor/common/vendor.js')));
    // Babel 插件同样不得改写：H5/App 运行时不存在 require.async
    const home = read(outDir, 'pages/tabbar/home/index.js');
    assert.ok(!home.includes('.async('), '非小程序平台 Babel 不得产出 require.async 调用');
    assert.ok(
      !home.includes('__non_webpack_require__'),
      '非小程序平台不得注入 __non_webpack_require__'
    );
  } finally {
    log.mock.restore();
  }
});
