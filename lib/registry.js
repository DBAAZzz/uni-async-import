/**
 * Babel 插件与 Webpack 插件间的进程内共享登记表：
 * Babel 转换 ?root= 时登记「哪个文件使用了哪个 root」，
 * Webpack 插件在 seal 阶段据此做交叉校验（配置漂移、vendor chunk 未产出）。
 *
 * 已知降级场景（此时校验为尽力而为，不误报但可能漏报）：
 * - babel-loader 缓存命中的文件不会重新转换，不产生登记；
 * - thread-loader 等多进程构建中 Babel 运行在 worker 进程，登记表不共享。
 * 冷构建（CI）始终具备完整覆盖。
 */
const filesToRoots = new Map();

function record(root, filename) {
  let roots = filesToRoots.get(filename);
  if (!roots) {
    roots = new Set();
    filesToRoots.set(filename, roots);
  }
  roots.add(root);
}

/** 返回 Map<root, 使用该 root 的示例文件路径> */
function getUsedRoots() {
  const usedRoots = new Map();
  for (const [filename, roots] of filesToRoots) {
    for (const root of roots) {
      if (!usedRoots.has(root)) {
        usedRoots.set(root, filename);
      }
    }
  }
  return usedRoots;
}

function reset() {
  filesToRoots.clear();
}

module.exports = { record, getUsedRoots, reset };
