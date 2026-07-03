const nodePath = require('path');
const { declare } = require('@babel/helper-plugin-utils');
const t = require('@babel/types');
const { PLUGIN_NAME, normalizeOptions, normalizeSlashes, trimPath } = require('./config');
const registry = require('./registry');

/** Windows 盘符路径在 posix 主机上 path.isAbsolute 为 false，需单独识别 */
function isAbsoluteAnyPlatform(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || nodePath.isAbsolute(p);
}

function resolveInputDir(raw, base) {
  if (!raw) {
    return raw;
  }
  return isAbsoluteAnyPlatform(raw) ? raw : nodePath.resolve(base, raw);
}

/**
 * 计算从 fromDir（源码根相对目录）到 toPath（源码根相对文件）的相对路径。
 * 不依赖 process.cwd()，跨平台确定性输出（始终 / 分隔）。
 */
function relativeFromDir(fromDir, toPath) {
  const from = fromDir ? fromDir.split('/').filter(Boolean) : [];
  const to = toPath.split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) {
    i++;
  }
  const ups = from.length - i;
  return (ups > 0 ? '../'.repeat(ups) : '') + to.slice(i).join('/');
}

/**
 * 计算 require.async 应使用的 vendor 相对路径。
 * 锚定 inputDir（uni-app 源码根，产物目录结构与其镜像），
 * 而非在绝对路径中猜测 pages 段位置。
 */
function computeVendorPath(filename, inputDir, root) {
  if (!inputDir) {
    throw new Error(
      `[${PLUGIN_NAME}] 未提供 inputDir 且环境变量 UNI_INPUT_DIR 不存在，无法计算 vendor 相对路径。`
    );
  }
  if (!filename) {
    throw new Error(`[${PLUGIN_NAME}] 无法获取当前文件路径（file.opts.filename 为空）。`);
  }
  const file = normalizeSlashes(filename).split('?')[0].split('#')[0];
  const input = normalizeSlashes(inputDir).replace(/\/+$/, '');
  if (!(file === input || file.startsWith(input + '/'))) {
    throw new Error(
      `[${PLUGIN_NAME}] 文件 ${file} 不在源码根目录 ${input} 之下，拒绝猜测 vendor 路径。`
    );
  }
  const segments = file
    .slice(input.length + 1)
    .split('/')
    .filter(Boolean);
  segments.pop(); // 去掉文件名，得到所在目录
  return relativeFromDir(segments.join('/'), `${root}/common/vendor.js`);
}

const plugin = declare((api, options = {}) => {
  api.assertVersion(7);

  // 延迟归一化：未配置 roots 的文件里没有 ?root= 时不应报错
  let normalizedRoots = null;
  const getConfiguredRoots = () => {
    if (!normalizedRoots) {
      normalizedRoots = normalizeOptions(options).roots.map((r) => r.root);
    }
    return normalizedRoots;
  };

  return {
    name: 'uni-async-import',
    pre(file) {
      this.filename = file.opts.filename;
      // 与 Webpack 插件同步：仅小程序平台生效。
      // H5/App 运行时不存在 require.async，改写会导致运行时崩溃。
      const platform = process.env.UNI_PLATFORM || process.env.VUE_APP_PLATFORM;
      const isMP = Boolean(platform && platform.startsWith('mp-'));
      this.shouldSkip = !isMP || !file.code.includes('?root=');
    },
    visitor: {
      CallExpression(callPath) {
        if (this.shouldSkip || !callPath.get('callee').isImport()) {
          return;
        }
        const arg = callPath.get('arguments')[0];
        if (!arg || !arg.isStringLiteral()) {
          return;
        }
        const importString = arg.node.value;
        const rootMatch = importString.match(/[?&]root=([^&]*)/);
        if (!rootMatch) {
          return;
        }

        const root = trimPath(decodeURIComponent(rootMatch[1]));
        const configuredRoots = getConfiguredRoots();
        if (!configuredRoots.includes(root)) {
          throw arg.buildCodeFrameError(
            `[${PLUGIN_NAME}] ?root=${root} 未在插件 roots 配置中声明。` +
              `已配置: ${configuredRoots.join(', ') || '(空)'}`
          );
        }

        const inputDir = resolveInputDir(
          options.inputDir || process.env.UNI_INPUT_DIR,
          process.cwd()
        );
        let vendorPath;
        try {
          vendorPath = computeVendorPath(this.filename, inputDir, root);
        } catch (error) {
          throw arg.buildCodeFrameError(error.message);
        }
        registry.record(root, this.filename);

        const cleanImportPath = importString.split('?')[0];
        const asyncCall = t.callExpression(
          t.memberExpression(t.identifier('__non_webpack_require__'), t.identifier('async')),
          [t.stringLiteral(vendorPath)]
        );
        const thenCallback = t.arrowFunctionExpression(
          [],
          t.blockStatement([
            t.returnStatement(
              t.callExpression(
                t.memberExpression(t.identifier('Promise'), t.identifier('resolve')),
                [t.callExpression(t.identifier('require'), [t.stringLiteral(cleanImportPath)])]
              )
            ),
          ])
        );
        callPath.replaceWith(
          t.callExpression(t.memberExpression(asyncCall, t.identifier('then')), [thenCallback])
        );
      },
    },
  };
});

module.exports = plugin;
// 导出纯函数便于单测（Windows 路径等场景无法通过 transformSync 在 posix 主机上模拟）
module.exports.computeVendorPath = computeVendorPath;
