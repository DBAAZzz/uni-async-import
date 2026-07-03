# uni-app 分包异步化插件 (uni-async-import)

[创作过程](https://juejin.cn/post/7520074335202885666)

[![NPM version](https://img.shields.io/npm/v/uni-async-import.svg?style=flat)](https://www.npmjs.com/package/uni-async-import)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个在 `uni-app` 框架中实现微信小程序**分包异步化**的 Webpack & Babel 插件组合。

> **适用范围**：本插件专为**存量 uni-app Vue2 + webpack 4** 项目设计。uni-app Vue3（Vite 工具链）不适用，也不在支持计划内。

## 背景痛点

`uni-app` 作为优秀的跨端框架，在小程序生态中被广泛使用。随着业务迭代，小程序主包体积超限成为常见问题。官方的"分包"方案虽然能解决代码体积问题，但带来了新的挑战：

当多个业务分包需要依赖一个**大型公共模块**（如直播、IM、视频播放器、E证通等 SDK）时：

- 若将 `vendor` 放在主包，会拖慢主包加载速度，影响用户体验。
- 若将 `vendor` 分别打包进各个业务分包，会造成代码冗余和分包体积增大。

**"分包异步化"** 是微信小程序官方提供的最佳解决方案：将大型公共模块作为一个独立的分包，在进入需要它的业务分包时，**先异步加载 `vendor` 分包，成功后再加载业务模块**。

然而，`uni-app`（Vue2 线）尚未原生支持此功能。本项目通过工程化手段，为 `uni-app` 开发者带来原生般的分包异步化体验。

## ✨ 功能特性

- **主包瘦身**：将大型公共模块从主包中剥离，显著减小主包体积。
- **任意分包 root**：支持微信允许的任意 root（不限 `pages/` 前缀、不限目录层级），如腾讯 E证通 SDK 的 `mp_ecard_sdk/protocol`。
- **共享配置契约**：Babel 插件与 Webpack 插件读同一份配置，root 声明一处生效。
- **构建期 fail-fast**：配置错误、root 未声明、`?root=` 未配置等问题在**构建期报错**，而不是等到线上运行时 404。
- **chunk graph 级实现**：vendor 依赖的摘除在 webpack chunk graph 层面完成，不做任何产物文本修改，不受代码内容、压缩、混淆影响。
- **完整测试覆盖**：基于真实项目结构裁剪的 fixture，`npm test` 跑真实 webpack 4 编译验证产物。

## 🚀 快速上手

### 1. 配置分包 (pages.json)

确保 `pages.json` 中已声明业务分包和作为公共依赖的 `vendor` 分包。**插件会在构建期校验配置的 root 是否在此声明**（`subPackages` / `subpackages` 两种拼写均可，允许条件编译注释）。

> 注意：下方示例是 **uni-app 的 `pages.json`**（源码文件，pages 条目为 `{ "path": ... }` 对象），不是微信编译产物 `app.json`（pages 为字符串数组）。插件只读取每个分包条目的 `root` 字段，两种形态都能正确解析。

```json
{
  "pages": [],
  "subPackages": [
    {
      "root": "pages/subpackage",
      "pages": [{ "path": "index/index" }]
    },
    {
      "root": "pages/subpackage-vendor",
      "pages": [{ "path": "index/index" }]
    }
  ]
}
```

### 2. 创建共享配置

两个插件必须读同一份配置。推荐在项目根目录创建 `async-import.config.js`：

```javascript
// async-import.config.js
module.exports = {
  roots: [
    {
      // 分包 root：必须与 pages.json 中的声明完全一致
      root: 'pages/subpackage-vendor',
      // 要打进该 vendor 分包的模块（源码根相对路径，路径边界精确匹配）
      include: ['pages/subpackage-vendor/request', 'pages/subpackage-vendor/im-sdk'],
    },
    {
      // 任意 root 均可，不限 pages/ 前缀
      root: 'mp_ecard_sdk/protocol',
      include: ['mp_ecard_sdk/protocol/sdk'],
    },
  ],
};
```

### 3. 配置 vue.config.js

```javascript
// vue.config.js
const AsyncImportPlugin = require('uni-async-import/webpack');
const asyncImportConfig = require('./async-import.config.js');

module.exports = {
  configureWebpack: {
    plugins: [new AsyncImportPlugin(asyncImportConfig)],
  },
};
```

### 4. 配置 babel.config.js

```javascript
// babel.config.js
const babelPluginAsyncWrapper = require('uni-async-import/babel/babel-plugin-async-wrapper');
const asyncImportConfig = require('./async-import.config.js');

module.exports = {
  plugins: [[babelPluginAsyncWrapper, asyncImportConfig]],
};
```

### 5. 在业务代码中使用

通过动态 `import()` 加载 vendor 模块，路径后附加 `?root=` 查询参数，值为**完整的分包 root**：

```javascript
// pages/subpackage/index/index.vue
export default {
  onLoad() {
    import('@/pages/subpackage-vendor/request.js?root=pages/subpackage-vendor')
      .then((res) => {
        res.getData();
      })
      .catch((err) => {
        console.error('异步模块加载失败', err);
      });
  },
};
```

编译后自动转换为符合小程序分包异步化规范的代码（相对路径按当前文件在源码根中的位置精确计算）：

```javascript
__non_webpack_require__.async('../../subpackage-vendor/common/vendor.js').then(() => {
  return Promise.resolve(require('@/pages/subpackage-vendor/request.js'));
});
```

## ⚙️ 构建期校验（fail-fast）

任何配置不一致都会在**构建期**报错，而不是等到线上运行时 404：

| 校验                                                                 | 时机           | 失败行为                         |
| -------------------------------------------------------------------- | -------------- | -------------------------------- |
| 配置 shape 合法、include 落在 root 之下、root 无嵌套、重复 root 合并 | 插件构造函数   | 抛错，说明期望格式               |
| 配置的每个 root 在 pages.json 中有声明                               | webpack 启动   | 抛错，列出未声明与已声明的 root  |
| 业务代码 `?root=` 的值在 roots 配置中                                | Babel 转换     | 定位到具体代码行的编译错误       |
| 当前文件在源码根（`UNI_INPUT_DIR`）之下                              | Babel 转换     | 抛错，不做任何路径猜测           |
| Babel 转换过的 root 与 Webpack 插件配置一致                          | 构建 seal 阶段 | **构建失败**（两处配置漂移）\*   |
| 已被使用的 root 产出了 vendor chunk                                  | 构建 seal 阶段 | **构建失败**（include 未命中）\* |
| 未被使用的配置 root 未产出 chunk                                     | 构建 seal 阶段 | 告警（死配置）                   |

\* 交叉校验依赖 Babel→Webpack 的进程内登记表：babel-loader 缓存命中或 thread-loader 多进程构建时降级为尽力检查（不误报、可能漏报）；冷构建 / CI 构建始终完整。

## 💡 最佳实践：配合 preloadRule

在业务页面的 `preloadRule` 中预下载 vendor 分包，`require.async` 触发时分包大概率已在本地，基本消除异步加载的延迟感：

```json
{
  "preloadRule": {
    "pages/subpackage/index/index": {
      "packages": ["pages/subpackage-vendor"]
    }
  }
}
```

## ⚠️ 已知限制

- **include 匹配语义**：条目可以是具体文件（省略 `.js` 扩展名），也可以是目录前缀（整个目录进 vendor），均为路径边界精确匹配（`request` 不会误命中 `request-helper`）。
- **传递依赖不会被图遍历自动收集**：若 `include` 命中的模块又 import 了 include 之外的模块，该依赖会流向 commons 或引用方 chunk。推荐做法：把 vendor 的内部依赖放进 vendor 分包目录，并用**目录前缀**形式 include 整个目录。
- **旧数组配置为兼容模式**：`new AsyncImportPlugin(['pages/xxx/request'])` 仍可用（root 自动取路径前两段，构建时打印弃用警告），但无法表达两段以上的任意 root，请迁移到 `{ roots: [...] }` 格式。

## 🛠 实现原理

1. **Babel 插件（源码转换）**：在 webpack 依赖分析前介入，将 `import('path?root=xxx')` 转换为 `__non_webpack_require__.async(相对路径).then(() => Promise.resolve(require(原路径)))`。`__non_webpack_require__` 绕过 webpack 的依赖分析，加载时机完全交给小程序运行时。相对路径锚定 `UNI_INPUT_DIR`（uni-app 源码根）计算，产物目录结构与源码镜像，因此结果精确。**两个插件都只在小程序平台（`UNI_PLATFORM` 为 `mp-*`）生效**——H5/App 构建下 `import()` 保持原样，走正常的 webpack 代码分割。

2. **Webpack 插件（打包与摘除）**：
   - **splitChunks**：为每个配置的 root 注入 cacheGroup，将 `include` 命中的模块（路径边界精确匹配）打包为 `<root>/common/vendor.js`；同时增强 uni-app 的 `commons` 组，排除 vendor 模块。
   - **chunk graph 摘除**：在 `afterOptimizeChunkIds` 阶段将 vendor chunk 与所有入口 chunk group 断开。webpack 渲染入口 chunk 时自然不会把 vendor 写进 webpackJsonp 依赖数组，小程序启动时不会同步等待异步分包。**全程不修改产物文本**。

## 📁 目录结构

```
lib/                  全部实现代码
  webpack-plugin.js     Webpack 插件（splitChunks 注入、chunk graph 摘除、交叉校验）
  babel-plugin.js       Babel 插件（import() 转换、平台门禁、fail-fast 校验）
  config.js             共享配置契约（归一化、嵌套/重复 root 校验）
  pages-json.js         pages.json 解析（双拼写、注释容忍、最长前缀匹配）
  registry.js           Babel→Webpack 进程内登记表（交叉校验用）
webpack/index.js      公开入口 require('uni-async-import/webpack')
babel/…-wrapper.js    公开入口 require('uni-async-import/babel/babel-plugin-async-wrapper')
test/                 node:test 用例 + 真实项目结构裁剪的 fixture
```

## 🧪 测试

```bash
npm test   # 40 个用例，含真实 webpack 4 编译的集成测试
npm run lint
```

测试 fixture 按真实项目结构裁剪，覆盖：主包/分包目录交错、非 `pages/` 前缀 SDK 分包、pages.json 小写拼写 + 条件编译注释、多入口共享 vendor 等场景。

## 📦 发布

发布前先更新版本号，并检查即将发布到 npm 的文件列表：

```bash
npm version patch
npm run publish:dry
```

确认无误后发布：

```bash
npm run release
```

`npm run release` 会执行 `npm publish`，发布前会通过 `prepublishOnly` 自动运行 `npm run lint && npm test`。

## 🤝 贡献

欢迎提交 PR 或 Issue，共同完善这个项目。

- [ ] 自动收集异步引入的文件
- [ ] 分包异步引入组件
- [ ] 分包异步化引入文件失败重试
