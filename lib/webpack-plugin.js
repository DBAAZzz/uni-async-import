const path = require('path');
const { PLUGIN_NAME, normalizeOptions, normalizeSlashes } = require('./config');
const { loadPagesJson, assertRootsDeclared } = require('./pages-json');
const registry = require('./registry');

/** Windows 盘符路径在 posix 主机上 path.isAbsolute 为 false，需单独识别 */
function isAbsoluteAnyPlatform(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || path.isAbsolute(p);
}

function resolveMaybeRelative(p, base) {
  if (!p) {
    return p;
  }
  return isAbsoluteAnyPlatform(p) ? p : path.resolve(base, p);
}

class AsyncImportPlugin {
  constructor(options) {
    // fail-fast：配置不合法在构造时即抛错，而不是构建中途
    this.config = normalizeOptions(options);
    const opts = Array.isArray(options) ? {} : options || {};
    this.inputDirOption = opts.inputDir;
    this.pagesJsonPathOption = opts.pagesJsonPath;
  }

  apply(compiler) {
    const platform = process.env.UNI_PLATFORM || process.env.VUE_APP_PLATFORM;
    if (!platform || !platform.startsWith('mp-')) {
      console.log(`[${PLUGIN_NAME}] 非小程序平台（${platform || 'unknown'}），插件不生效。`);
      return;
    }

    const base = compiler.context || process.cwd();
    const inputDir = resolveMaybeRelative(this.inputDirOption || process.env.UNI_INPUT_DIR, base);
    if (!inputDir) {
      throw new Error(
        `[${PLUGIN_NAME}] 需要源码根目录来匹配模块归属：请传入 inputDir 选项，或确保 UNI_INPUT_DIR 环境变量存在。`
      );
    }
    const pagesJsonPath =
      resolveMaybeRelative(this.pagesJsonPathOption, base) || path.join(inputDir, 'pages.json');

    // 校验：配置的每个 root 必须是 pages.json 声明的分包
    const { roots: declaredRoots } = loadPagesJson(pagesJsonPath);
    assertRootsDeclared(
      this.config.roots.map((r) => r.root),
      declaredRoots
    );

    this.updateSplitChunksConfig(compiler, inputDir);

    // 每次编译开始时清空登记表：本次编译中 Babel 转换到的 ?root= 会重新登记
    compiler.hooks.compile.tap(PLUGIN_NAME, () => {
      registry.reset();
    });

    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
      // chunk id 已定、hash 与渲染未开始的时点：从 chunk graph 摘除 vendor 依赖
      compilation.hooks.afterOptimizeChunkIds.tap(PLUGIN_NAME, (chunks) => {
        const foundChunkNames = this.detachVendorChunks(chunks);
        this.verifyVendorChunks(compilation, foundChunkNames);
      });
    });
  }

  /**
   * 模块是否命中 include 列表（路径边界感知：request 不误命中 request-helper）。
   * include 条目既可指向具体文件（不含扩展名），也可指向目录前缀。
   */
  moduleMatches(module, includeList, inputDir) {
    if (!module.resource) {
      return false;
    }
    const resource = normalizeSlashes(module.resource).split('?')[0];
    const input = normalizeSlashes(inputDir).replace(/\/+$/, '');
    if (!resource.startsWith(input + '/')) {
      return false;
    }
    const rel = resource.slice(input.length + 1);
    const relNoExt = rel.replace(/\.[^/.]+$/, '');
    return includeList.some((inc) => relNoExt === inc || rel === inc || rel.startsWith(inc + '/'));
  }

  matchesAnyInclude(module, inputDir) {
    return this.config.roots.some((r) => this.moduleMatches(module, r.include, inputDir));
  }

  updateSplitChunksConfig(compiler, inputDir) {
    const optimization = (compiler.options.optimization = compiler.options.optimization || {});
    const splitChunks = (optimization.splitChunks = optimization.splitChunks || {});
    const cacheGroups = (splitChunks.cacheGroups = splitChunks.cacheGroups || {});

    // 增强 uni-app 的 commons cacheGroup（如存在），排除 vendor 模块；
    // 不存在时静默跳过，不再假设宿主配置形态
    const commons = cacheGroups.commons;
    if (commons && typeof commons === 'object') {
      const originalTest = commons.test;
      commons.test = (module, chunks) => {
        if (this.matchesAnyInclude(module, inputDir)) {
          return false;
        }
        if (originalTest == null) {
          return true;
        }
        if (typeof originalTest === 'function') {
          return originalTest(module, chunks);
        }
        if (typeof originalTest === 'boolean') {
          return originalTest;
        }
        const name =
          (module.nameForCondition && module.nameForCondition()) || module.resource || '';
        if (originalTest instanceof RegExp) {
          return originalTest.test(name);
        }
        if (typeof originalTest === 'string') {
          return name.startsWith(originalTest);
        }
        return false;
      };
    }

    for (const { root, include } of this.config.roots) {
      const name = `${root}/common/vendor`;
      cacheGroups[name] = {
        name,
        chunks: 'all',
        enforce: true,
        priority: 20,
        test: (module) => this.moduleMatches(module, include, inputDir),
      };
    }
  }

  /**
   * 在 chunk graph 层面将 vendor chunk 与所有入口 chunk group 断开：
   * vendor chunk 仍会被独立产出到 `<root>/common/vendor.js`，
   * 但不再出现在任何入口 chunk 的 webpackJsonp 依赖数组中，
   * 小程序启动时不会同步等待异步分包（加载时机完全交给 require.async）。
   * 相比旧的 emit 阶段字符串删除，不再触碰产物文本，业务代码中的同名字符串安全。
   */
  detachVendorChunks(chunks) {
    const vendorNames = new Set(this.config.roots.map((r) => `${r.root}/common/vendor`));
    const found = new Set();
    for (const chunk of chunks) {
      if (!vendorNames.has(chunk.name)) {
        continue;
      }
      found.add(chunk.name);
      for (const group of Array.from(chunk.groupsIterable)) {
        group.removeChunk(chunk);
        chunk.removeGroup(group);
      }
    }
    return found;
  }

  /**
   * 交叉校验（消灭「构建成功、运行时 404」）：
   * - Babel 转换过的 root 不在本插件配置中 → 两处配置漂移，构建失败；
   * - Babel 转换过的 root 对应 vendor chunk 未产出（include 未命中）→ 构建失败；
   * - 配置了但无人使用且未产出 → 仅告警（死配置）。
   * 登记表在 babel-loader 缓存命中 / 多进程构建下不完整（见 lib/registry.js），
   * 此时校验降级为尽力而为；冷构建（CI）始终完整。
   */
  verifyVendorChunks(compilation, foundChunkNames) {
    if (compilation.errors.length > 0) {
      // 已有编译错误（如 Babel 的 ?root= 校验失败）时不再追加诊断噪音
      return;
    }
    const configRoots = new Set(this.config.roots.map((r) => r.root));
    const usedRoots = registry.getUsedRoots();
    for (const [root, filename] of usedRoots) {
      if (!configRoots.has(root)) {
        compilation.errors.push(
          new Error(
            `[${PLUGIN_NAME}] Babel 插件转换了 ?root=${root}（${filename}），` +
              `但 Webpack 插件配置中没有该 root。两个插件必须读取同一份 roots 配置。`
          )
        );
      } else if (!foundChunkNames.has(`${root}/common/vendor`)) {
        compilation.errors.push(
          new Error(
            `[${PLUGIN_NAME}] ?root=${root} 已被业务代码使用（${filename}），` +
              `但 include 未命中任何被引用的模块，vendor chunk 未产出，运行时 require.async 将加载失败。请检查 include 配置。`
          )
        );
      }
    }
    for (const root of configRoots) {
      if (!usedRoots.has(root) && !foundChunkNames.has(`${root}/common/vendor`)) {
        console.warn(
          `[${PLUGIN_NAME}] 配置的 vendor chunk "${root}/common/vendor" 本次构建未产出，` +
            `且没有业务代码使用 ?root=${root}（可能是无效配置）。`
        );
      }
    }
  }
}

module.exports = AsyncImportPlugin;
