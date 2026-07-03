const fs = require('fs');
const { PLUGIN_NAME, trimPath } = require('./config');

/**
 * 去除 JSON 中的行注释与块注释（字符串内的 // 不受影响）。
 * uni-app 的 pages.json 常含条件编译注释，不能裸 JSON.parse。
 */
function stripJsonComments(input) {
  let out = '';
  let i = 0;
  const n = input.length;
  let inString = false;
  let inLine = false;
  let inBlock = false;
  while (i < n) {
    const c = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next || '';
        i += 2;
        continue;
      }
      if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 解析 pages.json 内容，返回声明的分包 roots。
 * 同时读取 subPackages 与 subpackages 两种拼写（两者都合法且真实项目中都存在）。
 */
function parsePagesJson(content) {
  let json;
  try {
    json = JSON.parse(stripJsonComments(content));
  } catch (error) {
    throw new Error(`[${PLUGIN_NAME}] pages.json 解析失败: ${error.message}`);
  }
  const list = [].concat(json.subPackages || [], json.subpackages || []);
  const roots = list
    .map((sp) => sp && sp.root)
    .filter(Boolean)
    .map(trimPath);
  return { roots };
}

function loadPagesJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `[${PLUGIN_NAME}] 找不到 pages.json: ${filePath}。可通过 pagesJsonPath 选项显式指定。`
    );
  }
  return parsePagesJson(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 对声明的 roots 做路径边界感知的最长前缀匹配。
 * 返回命中的 root，未命中（主包路径）返回 null。
 */
function matchRoot(modulePath, roots) {
  const p = trimPath(modulePath);
  let best = null;
  for (const root of roots) {
    if ((p === root || p.startsWith(root + '/')) && (best === null || root.length > best.length)) {
      best = root;
    }
  }
  return best;
}

function assertRootsDeclared(configRoots, declaredRoots) {
  const missing = configRoots.filter((r) => !declaredRoots.includes(r));
  if (missing.length > 0) {
    throw new Error(
      `[${PLUGIN_NAME}] 以下 root 未在 pages.json 的 subpackages/subPackages 中声明: ` +
        `${missing.join(', ')}。已声明的分包 root: ${declaredRoots.join(', ') || '(无)'}`
    );
  }
}

module.exports = {
  stripJsonComments,
  parsePagesJson,
  loadPagesJson,
  matchRoot,
  assertRootsDeclared,
};
