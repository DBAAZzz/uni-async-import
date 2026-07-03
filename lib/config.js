const PLUGIN_NAME = 'AsyncImportPlugin';

const USAGE = '期望 { roots: [{ root, include }] }，或旧版字符串数组（兼容模式）。';

function normalizeSlashes(p) {
  return String(p).replace(/\\/g, '/');
}

function trimPath(p) {
  return normalizeSlashes(p)
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function fail(message) {
  throw new Error(`[${PLUGIN_NAME}] ${message}`);
}

/**
 * 归一化插件配置，Babel 插件与 Webpack 插件共用（共享契约的单一入口）。
 * 接受两种形态：
 *   - 新格式：{ roots: [{ root, include }] }
 *   - 旧格式（兼容模式）：字符串数组，root 取路径前两段
 * 返回 { roots: [{ root, include }] }，路径一律为 / 分隔、无首尾斜杠、include 去 .js 后缀。
 * 任何不合法输入立即抛错（fail-fast）。
 */
function normalizeOptions(options) {
  let rawRoots;
  if (Array.isArray(options)) {
    rawRoots = options;
  } else if (options && typeof options === 'object' && Array.isArray(options.roots)) {
    rawRoots = options.roots;
  } else {
    fail(`配置缺失或格式不合法。${USAGE}`);
  }

  if (rawRoots.length === 0) {
    fail(`roots 不能为空。${USAGE}`);
  }
  if (rawRoots.every((entry) => typeof entry === 'string')) {
    return { roots: postProcess(normalizeLegacy(rawRoots)) };
  }
  if (rawRoots.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
    return { roots: postProcess(normalizeModern(rawRoots)) };
  }
  fail(`roots 不能混用字符串与对象条目。${USAGE}`);
}

/**
 * 归一化后处理：
 * 1. 同一 root 重复声明时合并 include 并去重（避免 cacheGroup 同名静默覆盖）；
 * 2. 拒绝相互嵌套的 root——微信不允许分包根目录嵌套，且嵌套会导致模块归属不确定。
 */
function postProcess(roots) {
  const byRoot = new Map();
  for (const entry of roots) {
    const existing = byRoot.get(entry.root);
    if (existing) {
      for (const inc of entry.include) {
        if (!existing.include.includes(inc)) {
          existing.include.push(inc);
        }
      }
    } else {
      byRoot.set(entry.root, { root: entry.root, include: [...new Set(entry.include)] });
    }
  }
  const merged = [...byRoot.values()];
  for (const a of merged) {
    for (const b of merged) {
      if (a !== b && b.root.startsWith(a.root + '/')) {
        fail(
          `root "${a.root}" 与 "${b.root}" 相互嵌套。微信不允许分包根目录嵌套，且嵌套会导致模块归属不确定。`
        );
      }
    }
  }
  return merged;
}

function normalizeLegacy(entries) {
  console.warn(
    `[${PLUGIN_NAME}] 检测到旧版数组配置（兼容模式，root 取路径前两段）。` +
      `建议迁移到 { roots: [{ root, include }] } 以支持任意分包 root。`
  );
  const groups = new Map();
  for (const entry of entries) {
    const cleaned = trimPath(entry).replace(/\.js$/, '');
    const segments = cleaned.split('/').filter(Boolean);
    if (segments.length < 2) {
      fail(`旧版数组条目 "${entry}" 不足两段路径，无法推断分包 root。请使用新格式显式声明 root。`);
    }
    const root = `${segments[0]}/${segments[1]}`;
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root).push(cleaned);
  }
  return [...groups.entries()].map(([root, include]) => ({ root, include }));
}

function normalizeModern(entries) {
  return entries.map((entry, i) => {
    const where = `roots[${i}]`;
    if (typeof entry.root !== 'string' || trimPath(entry.root) === '') {
      fail(`${where}.root 必须是非空字符串。`);
    }
    const root = trimPath(entry.root);
    if (!Array.isArray(entry.include) || entry.include.length === 0) {
      fail(`${where}.include 必须是非空字符串数组。`);
    }
    const include = entry.include.map((inc) => {
      if (typeof inc !== 'string') {
        fail(`${where}.include 含非字符串条目。`);
      }
      const cleaned = trimPath(inc).replace(/\.js$/, '');
      if (!(cleaned === root || cleaned.startsWith(root + '/'))) {
        fail(`${where}: include "${inc}" 不在 root "${root}" 之下。`);
      }
      return cleaned;
    });
    return { root, include };
  });
}

module.exports = { PLUGIN_NAME, normalizeOptions, normalizeSlashes, trimPath };
