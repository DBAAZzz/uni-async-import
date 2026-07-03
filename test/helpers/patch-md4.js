// webpack 4 默认使用 md4 哈希，Node 17+ 的 OpenSSL 3 已移除 md4。
// 测试进程内将 md4 映射为 sha256，仅影响哈希值，不影响构建语义。
const crypto = require('crypto');

const originalCreateHash = crypto.createHash.bind(crypto);
crypto.createHash = (algorithm, options) =>
  originalCreateHash(algorithm === 'md4' ? 'sha256' : algorithm, options);
