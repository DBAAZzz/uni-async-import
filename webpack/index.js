const MagicString = require('magic-string');
const { RawSource } = require('webpack-sources'); // Webpack 4 使用 webpack-sources

const PLUGIN_NAME = 'AsyncImportPlugin';
class AsyncImportPlugin {
  constructor(options = {}) {
    this.options = options;
  }

  normalizePath(path) {
    let normalizedPath = path.replace(/^(\.\.\/|\.\/)+/, '').replace('.js', '');

    if (!normalizedPath.startsWith('pages/')) {
      normalizedPath = 'pages/' + normalizedPath;
    }

    return normalizedPath;
  }

  apply(compiler) {
    const platform = process.env.UNI_PLATFORM || process.env.VUE_APP_PLATFORM;
    const isMP = platform && platform.startsWith('mp-');

    if (!isMP) {
      console.log(`[${PLUGIN_NAME}] Plugin disabled, not an MP platform.`);
      return;
    }

    this.updateSplitChunksConfig(compiler);

    compiler.hooks.emit.tapAsync(PLUGIN_NAME, (compilation, callback) => {
      console.log(`[${PLUGIN_NAME}] Entered emit hook.`);
      for (const assetName in compilation.assets) {
        if (assetName.endsWith('.js')) {
          const asset = compilation.assets[assetName];
          const originalSource = asset.source();
          const magicString = new MagicString(originalSource);
          let modified = false;

          const webpackDynamicImportRegex = /require\.async\s*\(\s*(['"])(.+?)\1\s*\)/g;
          let match;
          while ((match = webpackDynamicImportRegex.exec(originalSource)) !== null) {
            const [fullMatch, _, packageParams] = match;
            const bundleName = this.normalizePath(packageParams);
            const textsToRemove = [`"${bundleName}",`, `"${bundleName}"`];

            for (const text of textsToRemove) {
              const index = originalSource.indexOf(text);
              if (index !== -1) {
                magicString.remove(index, index + text.length);
                break;
              }
            }

            if (!modified) {
              modified = true;
            }
          }

          if (modified) {
            // 只有在真正修改了文件时才更新资源
            const finalSource = magicString.toString();
            compilation.assets[assetName] = new RawSource(finalSource);
          }
        }
      }
      callback();
    });
  }

  updateSplitChunksConfig(compiler) {
    if (!compiler.options.optimization) {
      compiler.options.optimization = {};
    }

    const existingSplitChunks = compiler.options.optimization.splitChunks || {};
    const existingCacheGroups = existingSplitChunks.cacheGroups || {};
    const originalCommonsTest = existingCacheGroups.commons.test || (() => true);

    existingCacheGroups.commons.test = (module, chunks) => {
      // 增强 commons 的 test 函数，排除指定路径
      const resourcePath = module.resource ? module.resource.replace(/\\/g, '/') : '';
      const isExcluded = resourcePath && this.options.some((path) => resourcePath.includes(path));
      if (isExcluded) {
        return false;
      }

      return originalCommonsTest(module, chunks);
    };

    const newCacheGroups = this.getSplitChunkConfig();

    compiler.options.optimization.splitChunks = {
      ...existingSplitChunks,
      cacheGroups: {
        ...existingCacheGroups,
        ...newCacheGroups,
      },
    };
  }

  getSplitChunkConfig() {
    const pathsArray = this.options;
    if (!Array.isArray(pathsArray)) {
      console.warn(`[${PLUGIN_NAME}] options should be an array, received:`);
      return {};
    }

    const groups = pathsArray.reduce((acc, path) => {
      if (typeof path !== 'string') return acc;
      const parts = path.split('/');
      if (parts.length < 2) return acc;
      const key = `${parts[0]}/${parts[1]}`;
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(path);
      return acc;
    }, {});

    const cacheGroups = {};
    let priority = 20;
    for (const key in groups) {
      const paths = groups[key];
      const name = `${key}/common/vendor`;

      if (name) {
        cacheGroups[name] = {
          name: name,
          test: (module) => {
            return (
              module.resource && paths.some((p) => module.resource.replace(/\\/g, '/').includes(p))
            );
          },
          chunks: 'all',
          enforce: true,
          priority: 20,
        };
        priority += 10;
      }
    }

    return cacheGroups;
  }
}

module.exports = AsyncImportPlugin;
