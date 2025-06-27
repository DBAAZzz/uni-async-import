const { declare } = require('@babel/helper-plugin-utils');
const t = require('@babel/types');
const path = require('path');

function calculateRelativePath(currentFilePath, packageName) {
  try {
    const normalizedCurrentPath = currentFilePath.replace(/\\/g, '/');
    const cleanPath = normalizedCurrentPath.split('?')[0].split('#')[0];
    const currentDir = path.dirname(cleanPath).replace(/\\/g, '/');
    const currentSegments = currentDir.split('/').filter((segment) => segment && segment !== '.');
    const pagesIndex = currentSegments.findIndex((segment) => segment === 'pages');

    if (pagesIndex === -1) {
      return `pages/${packageName}/common/vendor.js`;
    }

    const upLevels = currentSegments.length - pagesIndex - 1;

    if (upLevels === 0) {
      return `${packageName}/common/vendor.js`;
    } else {
      return '../'.repeat(upLevels) + `${packageName}/common/vendor.js`;
    }
  } catch (error) {
    return `pages/${packageName}/common/vendor.js`;
  }
}

/**
 * 创建新的 AST 节点，表示异步 require 调用
 * @param {string} packageName - 从 ?root= 中提取的参数，即 '指定参数'
 * @param {string} fullImportPath - 原始的、完整的导入路径
 * @returns {t.CallExpression} - 新的 AST 节点
 */
function createAsyncRequireExpression(packageParams, fullImportPath, filaPath) {
  // 移除查询字符串
  const cleanImportPath = fullImportPath.split('?')[0];
  const packageName = packageParams.includes('/') ? packageParams.split('/')[1] : packageParams;
  const vendorPath = calculateRelativePath(filaPath, packageName);
  // 创建 asyncRequire.async(packageName)
  const asyncRequireCall = t.callExpression(
    t.memberExpression(t.identifier('__non_webpack_require__'), t.identifier('async')),
    [t.stringLiteral(vendorPath)]
  );

  // 创建回调函数: () => { return Promise.resolve(require(cleanImportPath)) }
  const thenCallback = t.arrowFunctionExpression(
    [],
    t.blockStatement([
      t.returnStatement(
        t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('resolve')), [
          t.callExpression(t.identifier('require'), [t.stringLiteral(cleanImportPath)]),
        ])
      ),
    ])
  );
  return t.callExpression(t.memberExpression(asyncRequireCall, t.identifier('then')), [
    thenCallback,
  ]);
}

/**
 * 处理 import 转换的核心逻辑
 * @param {import('@babel/core').NodePath} path - Babel 访问器提供的当前节点路径 (即 import() 对应的 CallExpression 路径)
 * @param {string} importString - 包含查询参数的导入路径字符串
 */
function transformImport(path, importString, filaPath) {
  try {
    const rootMatch = importString.match(/[?&]root=([^&]*)/);
    if (!rootMatch) return;

    const packageName = decodeURIComponent(rootMatch[1]);
    if (!packageName) return;

    const newExpression = createAsyncRequireExpression(packageName, importString, filaPath);

    // 直接替换当前的 import() 节点
    path.replaceWith(newExpression);
  } catch (error) {
    console.error(`[AsyncWrapper] Error processing ${importString}:`, error.message, error.stack);
  }
}

module.exports = declare((api) => {
  api.assertVersion(7);
  return {
    name: 'async-wrapper',
    pre(file) {
      this.currentFilePath = file.opts.filename;
      if (!file.code.includes('?root=')) {
        this.shouldSkip = true;
      }
    },
    visitor: {
      CallExpression(path) {
        if (this.shouldSkip || !path.get('callee').isImport()) {
          return;
        }
        const arg = path.get('arguments')[0];
        if (arg && arg.isStringLiteral() && arg.node.value.includes('?root=')) {
          // 传入 import() 节点路径
          transformImport(path, arg.node.value, this.currentFilePath);
        }
      },
    },
  };
});
