# 架构与系统设计评审报告

- **评审对象**：uni-async-import（webpack/index.js + babel/babel-plugin-async-wrapper.js）
- **评审日期**：2026-07-03
- **项目定位（已确认）**：面向**存量 uni-app Vue2 + webpack 4** 项目的分包异步化插件。不支持、也不计划支持 Vue3 / Vite 工具链。

---

## 一、总体判断

项目的**技术思路是正确的**：Babel 阶段做 AST 转换、用 `__non_webpack_require__` 绕过 webpack 依赖分析，把加载时机交给小程序运行时；Webpack 阶段通过 splitChunks 控制 vendor 落位。这个分工是这类问题的标准解法。

但**实现处在"demo 能跑"的阶段，离"可依赖的工程化插件"有明显距离**。核心问题不是代码风格，而是三件事：

1. emit 阶段的字符串手术是架构性风险源；
2. 对宿主（uni-app 内部 webpack 配置）的隐式假设会导致启动即崩；
3. 零测试意味着任何改动都是盲改。

README 中"稳定可靠"的宣称目前不成立。既然定位是服务存量项目的稳定性工具，**稳定性本身就是唯一的产品价值**，以下问题的优先级应高于一切新特性。

---

## 二、P0 — 现在就会咬人的问题

### P0-1 `webpack/index.js:78` 必然崩溃的隐式假设

```js
const originalCommonsTest = existingCacheGroups.commons.test || (() => true);
```

无条件读取 `existingCacheGroups.commons`。只要用户的 splitChunks 配置里没有名为 `commons` 的 cacheGroup（自定义配置、uni-app 版本差异、插件加载顺序导致 uni-app 配置尚未注入），插件在 `apply` 阶段直接 TypeError，整个构建挂掉，且报错信息与插件毫无关联，排查成本极高。

进一步：即使 `commons` 存在，其 `test` 也可能是正则或字符串而非函数——`originalCommonsTest(module, chunks)` 会再崩一次。

这是对 uni-app 某个特定版本内部配置的强耦合，且没有任何防御和错误提示。

**修复方向**：`commons` 不存在时跳过增强并给出警告；`test` 按 webpack 语义兼容函数 / 正则 / 字符串三种形态；关键假设不满足时输出带插件名的可读报错。

### P0-2 构造函数契约自相矛盾

`constructor(options = {})` 默认值是对象，但 `webpack/index.js:83` 调用 `this.options.some(...)`——用户不传参数或传对象时，在小程序平台上直接崩。`getSplitChunkConfig` 里的 `Array.isArray` 检查执行得太晚（`updateSplitChunksConfig` 中的 `.some` 先跑）。

**修复方向**：参数校验集中在构造函数，fail-fast，报错信息说人话（期望什么、收到了什么、示例写法）。

### P0-3 emit 阶段的字符串手术是最大的架构债（`webpack/index.js:31-68`）

当前逻辑：对每个 `.js` 产物正则匹配 `require.async("...")`，然后用 `originalSource.indexOf('"pages/xxx/common/vendor",')` 在**整个文件里找第一个匹配的字符串并删掉**。问题：

- **删除位置是任意的**。`indexOf` 不理解 webpackJsonp 的结构，只是找第一个长得像的字符串。业务代码中恰好存在相同字符串字面量（日志、配置、路由表）时，删的就是业务代码。
- **同一 bundle 被多处异步引用时清理不完整**。while 循环每轮 `indexOf` 找到的都是同一位置（`originalSource` 不变），其他 chunk 依赖数组中的残留项清不掉。
- 正则 `require\.async` 会匹配产物中**任何**形态相似的调用，包括用户自己或其他框架生成的代码。
- `normalizePath` 中 `path.replace('.js', '')` 只替换首次出现且不锚定结尾，`foo.js.bar/x.js` 这类路径会被替错。

**根本问题：这是在治症状而不是病根。**"webpack 把 vendor chunk 记进了入口的依赖数组"的正确解法在 chunk graph 层面——在 `optimizeChunks` / chunk group 阶段把 vendor chunk 从父 chunk group 的依赖中摘除，或调整 splitChunks 使其根本不成为入口依赖。对最终产物做正则删字符串，属于"uni-app 或 webpack 下一个小版本改一下输出格式就全线崩溃"的设计。README 的三个 roadmap（自动收集、异步组件、失败重试）没有一个能在这个地基上安全地实现。

### P0-4 零测试

对一个价值主张是"dev 和 build 环境下均可稳定运行"的构建插件，没有任何测试 fixture 是最大的单点风险——上述每一条修复都无法验证不引入回归。

**最低要求**：一个最小化的 uni-app 风格 fixture 工程 + 用 webpack Node API 跑完整编译 + 对产物做断言（vendor chunk 落在正确目录、依赖数组被正确清理、`require.async` 调用形态正确）。写一次，后续所有重构都有安全网。

---

## 三、P1 — 会持续拖慢迭代的问题

### P1-1 三方约定靠字符串裸对齐，无任何校验（已定方案见第七节）

方案要求三处配置严格一致：业务代码中的 `?root=`、Webpack 插件构造参数数组、Babel 插件推算出的 `<root>/common/vendor.js` 路径。三者之间**没有共享配置、没有构建期校验**。

最恶劣的失败模式由此产生：用户写了 `?root=` 但忘了加进 Webpack 插件数组时，**构建照样成功，小程序运行时才 404**——失败被延迟到线上才暴露。

**修复方向**：抽一个共享配置模块（两个插件读同一份）；构建结束时交叉校验（Babel 转换过的 root 是否都在 splitChunks 名单中），对不上就构建失败。

### P1-2 Babel 插件的路径推算过脆（`babel/babel-plugin-async-wrapper.js:5-27`）（已定方案见第七节）

- `calculateRelativePath` 在**绝对路径**中 `findIndex(segment === 'pages')` 找第一个 `pages` 段——用户项目路径本身包含 `pages` 目录时（如 `/Users/x/pages-projects/app/...`）整个相对路径计算就错了。
- `packageParams.split('/')[1]` 只取第二段，意味着分包 root 必须是 `pages/xxx` 两段式且与引用方是兄弟目录——嵌套分包、非 `pages/` 前缀的 root（微信本身允许）全部不支持，且失败是静默的。
- `transformImport` 的 try/catch 吃掉异常只打日志继续构建——未转换的 `import()` 会被 webpack 正常代码分割，产出一个运行时才炸的包。构建插件应 fail-fast。

### P1-3 打包发布层面的硬伤

- `webpack` 被声明为 `dependencies`（package.json:21），会向用户项目安装第二份 webpack，与 uni-app 自带版本冲突风险很高。**必须改为 `peerDependencies`**。
- `webpack/index.js:2` require 了 `webpack-sources`，但 package.json 中**未声明**。当前靠 hoisting 侥幸可用，pnpm / 严格模式下直接找不到模块。
- 包身份混乱：package.json 名为 `uni-async-import`，README 徽章指向 `uni-app-async-subpackage-plugin`；license 一边是 ISC 一边是 MIT，且无 LICENSE 文件。发 npm 前必须理清。

### P1-4 死代码暴露的意图偏差（`webpack/index.js:122-139`）

`priority` 变量每轮 `+= 10` 但 cacheGroup 永远写死 `priority: 20`。意图应是让多个 vendor 组优先级递增避免争抢模块，实际未生效——多组同优先级时，一个模块同时匹配多组的归属顺序是未定义的。`if (name)` 恒真，同为死代码。

---

## 四、P2 — 值得记录但不急

- `filaPath` 拼写贯穿 Babel 插件（应为 `filePath`），零成本修复。
- emit hook 在 watch 模式下每次重编译全量扫描所有 `.js` 产物，大项目会拖慢 HMR；P0-3 重构到 chunk graph 层面后此问题自然消失。
- eslint 配置只挂了 prettier，无任何实质 lint 规则（`no-undef` 一类规则本可抓住"依赖未声明"的近亲问题）。

---

## 五、定位决策及其推论

**已确认**：本项目专为存量 uni-app Vue2 + webpack 4 项目服务，不追随 Vite / Vue3 工具链。

由此推论：

1. **README 必须明确写出适用范围**（webpack 4 + Vue2 编译器专用），避免 Vue3 用户误装后浪费双方时间。
2. 目标用户是**不敢轻易升级工具链的存量项目**，他们对插件的第一要求就是"不给我惹新麻烦"——稳定性和可预测的失败（构建期报错而非运行期 404）比任何新特性都重要。
3. webpack 4 已冻结，宿主环境不再演进，这反而是利好：**一次把 chunk graph 层面的正确实现做对，之后维护成本趋近于零**。字符串手术那种"随宿主输出格式漂移而失效"的担忧，唯一来源只剩 uni-app 编译器自身的小版本变动。

---

## 六、建议的动手顺序

| 顺序 | 任务                                                                                                                | 对应问题           | 预估投入                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------- |
| 1    | 搭建 fixture + webpack Node API 集成测试                                                                            | P0-4               | 0.5–1 天                                       |
| 2    | 修崩溃点与契约：防御 `commons` 缺失、构造函数校验、`peerDependencies`、补声明 `webpack-sources`、理清包名与 license | P0-1 / P0-2 / P1-3 | 数小时                                         |
| 3    | **重构 emit 字符串手术为 chunk graph 操作**                                                                         | P0-3               | 项目内唯一"重构"级任务，从 demo 到插件的分水岭 |
| 4    | 抽共享配置 + 构建期交叉校验，消灭"构建成功、运行时 404"                                                             | P1-1 / P1-2        | 1–2 天                                         |
| 5    | 之后再做 roadmap 特性（自动收集 / 异步组件 / 失败重试）                                                             | —                  | 在当前地基上做这些是给债务加杠杆               |

**一句话总结：方向对、地基虚。先把字符串手术换成 chunk graph 层面的正规操作，补上测试和 fail-fast 校验，其余功能全部往后排。**

---

## 七、已定契约设计（P1-1 / P1-2 的正式解决方案）

> 本节为评审后的设计决策记录，实现采用 TDD 驱动（先写测试再实现）。

### 7.1 背景结论

微信允许任意分包 root（不限于 `pages/` 前缀、不限两段式）。真实项目配置（见 7.5 fixture 规格来源）证实：

- 存在非 `pages/` 前缀的 root：`mp_ecard_sdk/protocol`（腾讯 E证通 SDK 规定目录，用户无改名自由）；
- 主包目录与分包 root 在同一前缀下交错：`mp_ecard_sdk/index/*` 是主包页面而 `mp_ecard_sdk/protocol` 是分包；`pages/tabbar` 是主包而其兄弟目录 `pages/userinfo` 是分包。

**因此：root 边界无法从模块路径字符串推断，pages.json 是唯一权威仲裁者；root 必须成为显式配置和两插件间的共享契约。**

### 7.2 配置契约

**主 API（新格式）：**

```js
// vue.config.js
new AsyncImportPlugin({
  roots: [
    {
      root: 'pages/subpackage-vendor',
      include: ['pages/subpackage-vendor/request', 'pages/subpackage-vendor/im-sdk'],
    },
    {
      root: 'mp_ecard_sdk/protocol',
      include: ['mp_ecard_sdk/protocol/sdk'],
    },
  ],
});
```

- `root`：分包 root，必须出现在 pages.json 的 subpackages 声明中（构建期校验）。
- `include`：源码根（`UNI_INPUT_DIR`）相对路径，必须落在 `root` 之下（解析配置时校验）；匹配为**路径边界感知**的前缀匹配（`request` 不得误命中 `request-helper`）。
- Babel 插件读取**同一份配置**（相同的 shape，含旧数组兼容），实现共享契约。

**兼容模式（旧数组格式）：** `new AsyncImportPlugin(['pages/xxx/request'])` 保留，在配置解析边界归一化为新格式（root 取前两段路径）并打印弃用警告。**内部只保留一套代码路径。** 限制为两段式 root（不限 `pages/` 前缀）。

**业务代码：** `import('@/pages/subpackage-vendor/request.js?root=pages/subpackage-vendor')` —— `?root=` 的值是完整分包 root，不再做 `split('/')[1]` 截取。

**Babel 转换产物：** 保持**文件相对路径**（微信 `require.async` 的已验证形态），锚定 `UNI_INPUT_DIR` 计算——当前文件相对源码根的位置确定，产物目录结构与源码镜像，故相对路径可精确推出。**废除在绝对路径中猜 `pages` 段位置的做法。** 根相对路径形态未经真机验证，不写入契约。

```js
// pages/subpackage/index/index.vue 中的 import 转换为：
__non_webpack_require__
  .async('../../subpackage-vendor/common/vendor.js')
  .then(() => Promise.resolve(require('@/pages/subpackage-vendor/request.js')));
```

### 7.3 构建期 fail-fast 校验清单

| #   | 校验                                                  | 时机            | 失败行为                                                          |
| --- | ----------------------------------------------------- | --------------- | ----------------------------------------------------------------- |
| 1   | 配置 shape 合法、include ⊆ root                       | 插件构造函数    | 抛错，报错说明期望格式                                            |
| 2   | 每个配置的 root 在 pages.json 的 subpackages 中有声明 | webpack `apply` | 抛错，列出未声明的 root 与已声明清单                              |
| 3   | 业务代码 `?root=` 的值 ∈ 配置的 roots                 | Babel 转换时    | `buildCodeFrameError` 抛错（构建失败，不再 console.error 后继续） |
| 4   | 当前文件在 `UNI_INPUT_DIR` 之下                       | Babel 转换时    | 抛错（不再静默 fallback 到猜测路径）                              |

### 7.4 pages.json 解析注意事项

- **键名双拼写**：`subPackages` 与 `subpackages` 都合法且真实存在（fixture 来源项目用的是小写），解析必须同时读两个键。
- **容忍注释**：真实 uni-app pages.json 常含条件编译注释（`// #ifdef MP-WEIXIN`），不能裸 `JSON.parse`。
- **最长前缀匹配**：模块路径对声明 roots 做路径边界感知的最长前缀匹配（`mp_ecard_sdk/protocol/x` → 命中；`mp_ecard_sdk/index/x` → 主包）。

### 7.5 配套实践与已知限制

- **preloadRule 配套**（写入 README 最佳实践）：在业务页面的 `preloadRule` 中加入 vendor 分包 root，`require.async` 触发时分包大概率已在本地，消除异步加载延迟感。插件无需做任何事。
- **已知限制（写入 README）**：路径匹配的 cacheGroup test 只捕获 `include` 列出的模块本身，其**传递依赖**不会进 vendor chunk，会流向 commons 或引用方 chunk。图遍历方案留待后续。
- **本次需求不含 P0-3**（emit 字符串手术 → chunk graph 重构），但 emit 清理逻辑需最小修正以适配任意 root：依赖数组中的 chunk 名从 `require.async` 的相对路径参数按产物位置解析得出，废除 `normalizePath` 的 `pages/` 硬编码；同一 bundle 多处引用时清理全部残留（修复 `indexOf` 只删第一处的 bug）。

### 7.6 测试 fixture 规格（TDD）

以真实项目配置裁剪为最小 fixture（`test/fixtures/demo/`），覆盖：

- 主包页面在 `pages/tabbar/*`，与分包 root 兄弟混居；
- 业务分包 `pages/biz` + vendor 分包 `pages/biz-vendor`（两段式，兼容旧写法场景）；
- 非 `pages/` 前缀 SDK 分包 `mp_ecard_sdk/protocol`，且 `mp_ecard_sdk/index` 属主包（前缀交错场景）；
- pages.json 使用小写 `subpackages` 且含 `//` 注释；
- webpack 配置带 `runtimeChunk: 'single'` + uni-app 风格 `commons` cacheGroup，产出含依赖数组的 webpackJsonp 入口 chunk。

断言口径：vendor chunk 落位正确、`require.async` 相对路径正确、入口 chunk 依赖数组中 vendor 被清理且 `common/vendor` 未被误删、vendor 模块不进 commons、四条 fail-fast 校验各有一个失败用例。

---

## 八、整改记录（2026-07-03，TDD 驱动，32 个测试全绿）

| 问题                        | 状态      | 整改内容                                                                                                                                                                                    |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 `commons` 隐式假设崩溃 | ✅ 已修复 | `commons` 不存在时静默跳过；`test` 兼容函数 / 正则 / 字符串三种形态（webpack/index.js `updateSplitChunksConfig`）                                                                           |
| P0-2 构造函数契约矛盾       | ✅ 已修复 | 配置归一化与校验集中在 `shared/config.js`，构造函数即抛可读错误；有失败用例覆盖                                                                                                             |
| P0-3 emit 字符串手术        | ✅ 已重构 | 删除全部产物文本修改，改为 `afterOptimizeChunkIds` 阶段将 vendor chunk 与入口 chunk group 断开（chunk graph 层面）。回归测试：业务代码中与 chunk 同名的字符串字面量原样保留                 |
| P0-4 零测试                 | ✅ 已补齐 | `npm test`：32 用例（config 10 / pages-json 7 / babel 9 / webpack 集成 6+），集成测试跑真实 webpack 4 编译并断言产物                                                                        |
| P1-1 三方约定无校验         | ✅ 已修复 | 共享配置模块 + 第七节 5 条构建期校验全部落地（含 vendor chunk 未产出告警）                                                                                                                  |
| P1-2 Babel 路径推算脆弱     | ✅ 已修复 | 锚定 `UNI_INPUT_DIR` 计算相对路径；任意 root；异常一律 `buildCodeFrameError` fail-fast                                                                                                      |
| P1-3 打包发布硬伤           | ✅ 已修复 | `webpack` 移至 peerDependencies（^4.0.0）+ devDependencies；`magic-string` / `webpack-sources` 随 P0-3 重构移除依赖；license 统一 MIT 并补 LICENSE 文件；README 徽章指向 `uni-async-import` |
| P1-4 priority 死代码        | ✅ 已消除 | 插件重写后不存在该代码                                                                                                                                                                      |
| P2 `filaPath` 拼写          | ✅ 已消除 | 插件重写                                                                                                                                                                                    |
| P2 emit watch 全量扫描      | ✅ 已消除 | 随 P0-3 重构自然消失（不再读产物）                                                                                                                                                          |
| P2 eslint 无实质规则        | ✅ 已修复 | eslint@8 + `eslint:recommended`，新增 `npm run lint`，当前零告警                                                                                                                            |
| 五-1 README 适用范围        | ✅ 已修复 | README 重写：适用范围声明、新配置契约、fail-fast 校验表、preloadRule 实践、已知限制、兼容模式说明                                                                                           |

**仍开放的事项**（非缺陷，为后续演进）：README roadmap 三项（自动收集 / 异步组件 / 失败重试）；`require.async` 根相对路径形态的真机验证（当前采用已验证的文件相对路径，无需变更）。

### 8.1 第二轮整改（同日，外部复审 findings，40 个测试全绿）

| Finding                                         | 状态                | 整改内容                                                                                                                                                                                                     |
| ----------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1 Babel 在非小程序构建仍改写代码               | ✅ 已修复           | Babel 插件加平台门禁（`UNI_PLATFORM`/`VUE_APP_PLATFORM` 须为 `mp-*`），H5/App 下 `import()` 保持原样；测试覆盖 h5 单测 + 集成产物断言                                                                        |
| P1 Babel/Webpack 配置可不一致且不失败           | ✅ 已修复           | 新增 `shared/registry.js` 进程内登记表：Babel 转换时登记 root+文件，Webpack seal 阶段交叉校验，漂移即构建失败。缓存/多进程降级为尽力检查（代码与 README 注明），冷构建/CI 完整                               |
| P1 include 配错只 warn 仍可能 404               | ✅ 已修复           | 已被使用的 root 未产出 vendor chunk → `compilation.errors`（构建失败）；未被使用的死配置 → 保留告警                                                                                                          |
| P1 overlapping roots 归属不确定                 | ✅ 已修复           | 配置期直接拒绝嵌套 root（微信本身禁止分包根目录嵌套），报错说明原因                                                                                                                                          |
| P1 duplicate root 静默覆盖                      | ✅ 已修复           | `normalizeOptions` 后处理：同 root 合并 include 并去重                                                                                                                                                       |
| P2 commons.test 缺 boolean 分支                 | ✅ 已修复（附勘误） | 包装函数补 boolean 分支与未知类型 fallback false；**勘误：webpack 4 schema 在插件 apply 前即拒绝 boolean test，用户配置无法触达该分支**，测试固化了这一事实（string 形态语义保留 + boolean 被 webpack 拒绝） |
| P2 inputDir 相对路径失配                        | ✅ 已修复           | Webpack 侧按 `compiler.context` 解析，Babel 侧按 `process.cwd()` 解析；Windows 盘符路径单独识别；两侧均有测试                                                                                                |
| P2 README include 语义不一致                    | ✅ 已修复           | 已知限制章节重写：明确文件/目录前缀两种形态与路径边界匹配，推荐目录 include 收纳传递依赖                                                                                                                     |
| P2 非小程序测试覆盖不足                         | ✅ 已修复           | 集成测试补断言：产物中无 `.async(` 与 `__non_webpack_require__`                                                                                                                                              |
| P2 package-lock license/peerDependencies 未同步 | ✅ 已修复           | 重新生成 lockfile，根包段 license=MIT、peerDependencies 已同步                                                                                                                                               |
| P3 已有编译错误时仍打印 vendor 告警             | ✅ 已修复           | `verifyVendorChunks` 在 `compilation.errors` 非空时跳过全部诊断                                                                                                                                              |

### 8.2 目录结构整合（同日）

实现代码原先散在 `webpack/`、`babel/`、`shared/` 三个顶层目录，已全部集中到 `lib/`（`webpack-plugin.js` / `babel-plugin.js` / `config.js` / `pages-json.js` / `registry.js`）。`webpack/index.js` 与 `babel/babel-plugin-async-wrapper.js` 保留为一行 re-export 的薄入口——这两个路径是 README 承诺的公开 API（`require('uni-async-import/webpack')` 等），消费者引用路径不变。测试对两个插件仍走公开入口路径，薄入口本身也在测试覆盖内。
