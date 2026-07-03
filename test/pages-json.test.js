const { test } = require('node:test');
const assert = require('node:assert');
const { parsePagesJson, matchRoot, assertRootsDeclared } = require('../lib/pages-json');

test('解析小写 subpackages，容忍行注释/块注释，不误伤字符串内的 //', () => {
  const content = `{
    // #ifdef MP-WEIXIN
    "lazyCodeLoading": "requiredComponents", /* 块注释 */
    // #endif
    "someUrl": "https://example.com/a//b",
    "pages": [{ "path": "pages/tabbar/home/index" }],
    "subpackages": [
      { "root": "pages/biz", "pages": [{ "path": "index/index" }] },
      { "root": "mp_ecard_sdk/protocol", "pages": [{ "path": "eid/eid" }] }
    ]
  }`;
  assert.deepStrictEqual(parsePagesJson(content).roots, ['pages/biz', 'mp_ecard_sdk/protocol']);
});

test('解析大写 subPackages', () => {
  const content = `{ "subPackages": [{ "root": "pages/userinfo" }] }`;
  assert.deepStrictEqual(parsePagesJson(content).roots, ['pages/userinfo']);
});

test('两种拼写同时存在时合并', () => {
  const content = `{
    "subPackages": [{ "root": "pages/a" }],
    "subpackages": [{ "root": "pages/b" }]
  }`;
  assert.deepStrictEqual(parsePagesJson(content).roots.sort(), ['pages/a', 'pages/b']);
});

test('无分包声明时返回空数组', () => {
  assert.deepStrictEqual(parsePagesJson('{ "pages": [] }').roots, []);
});

test('容忍微信原生 app.json 格式（pages 为字符串数组、含 entry/name 字段）', () => {
  // 微信官方文档示例：https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages/basic.html
  // 插件只读取每个分包条目的 root 字段，pages 的形态（字符串/对象）与 entry、name 等字段均不影响
  const content = `{
    "pages": ["pages/index", "pages/logs"],
    "subPackages": [
      {
        "root": "packageA",
        "pages": ["pages/cat", "pages/dog"],
        "entry": "index.js"
      },
      {
        "root": "packageB",
        "name": "pack2",
        "pages": ["pages/apple", "pages/banana"]
      }
    ]
  }`;
  assert.deepStrictEqual(parsePagesJson(content).roots, ['packageA', 'packageB']);
});

test('JSON 语法错误时报可读错误', () => {
  assert.throws(() => parsePagesJson('{ oops }'), /pages\.json/);
});

test('matchRoot：最长前缀 + 路径边界感知', () => {
  const roots = ['pages/biz', 'pages/biz-vendor', 'mp_ecard_sdk/protocol'];
  assert.strictEqual(matchRoot('pages/biz-vendor/request.js', roots), 'pages/biz-vendor');
  assert.strictEqual(matchRoot('pages/biz/index/index.js', roots), 'pages/biz');
  // 边界：pages/biz 不得命中 pages/bizarre
  assert.strictEqual(matchRoot('pages/bizarre/x.js', roots), null);
  // 主包/分包前缀交错：mp_ecard_sdk/index 是主包
  assert.strictEqual(matchRoot('mp_ecard_sdk/index/index.js', roots), null);
  assert.strictEqual(matchRoot('mp_ecard_sdk/protocol/eid/eid.js', roots), 'mp_ecard_sdk/protocol');
});

test('assertRootsDeclared：通过与失败', () => {
  assert.doesNotThrow(() => assertRootsDeclared(['pages/biz'], ['pages/biz', 'x/y']));
  assert.throws(() => assertRootsDeclared(['pages/nope'], ['pages/biz']), /pages\/nope/);
});
