const clone = require('lodash.clonedeep');
const Config = require('webpack-chain');
const isPlainObject = require('is-plain-object');
const merge = require('deepmerge');
const { isAbsolute, join } = require('path');
const { source } = require('./extensions');

const getRoot = ({ root }) => root;
const normalizePath = (base, path) =>
  (isAbsolute(path) ? path : join(base, path));
const pathOptions = [
  ['root', '', () => process.cwd()],
  ['source', 'src', getRoot],
  ['output', 'build', getRoot],
  ['tests', 'test', getRoot],
  ['node_modules', 'node_modules', getRoot]
];
const requireFromRoot = (moduleId, root) => {
  const paths = [
    join(root, moduleId),
    join(root, 'node_modules', moduleId),
    moduleId
  ];
  const path = paths.find(path => {
    try {
      require.resolve(path);
      return true;
    } catch (err) {
      return path === paths[paths.length - 1];
    }
  });

  return require(path); // eslint-disable-line global-require
};

module.exports = class Neutrino {
  constructor(options) {
    this.options = this.getOptions(options);
    this.config = new Config();
    this.outputHandlers = new Map();
  }

  getOptions(opts = {}) {
    let moduleExtensions = new Set(source);
    const options = {
      debug: false,
      ...clone(opts)
    };

    if (!options.mains) {
      Object.assign(options, {
        mains: {
          index: 'index'
        }
      });
    }

    pathOptions.forEach(([path, defaultValue, getNormalizeBase]) => {
      let value = options[path] || defaultValue;

      Reflect.defineProperty(options, path, {
        enumerable: true,
        get() {
          return normalizePath(getNormalizeBase(options), value);
        },
        set(newValue) {
          value = newValue || defaultValue;
        }
      });
    });

    try {
      // eslint-disable-next-line global-require
      options.packageJson = require(join(options.root, 'package.json'));
    } catch (err) {
      options.packageJson = null;
    }

    Object.defineProperty(options, 'extensions', {
      enumerable: true,
      get() {
        return [...moduleExtensions];
      },
      set(extensions) {
        moduleExtensions = new Set(extensions.map(ext => ext.replace('.', '')));
      }
    });

    this.bindMainsOnOptions(options);

    return options;
  }

  mergeOptions(options, newOptions) {
    const pathKeys = pathOptions.map(([path]) => path);

    Object
      .keys(newOptions)
      .forEach(key => {
        if (key === 'mains') {
          this.bindMainsOnOptions(newOptions, options);
          Object.assign(options, { mains: newOptions.mains });
          return;
        }

        const value = newOptions[key];

        if (pathKeys.includes(key)) {
          Object.assign(options, { [key]: value });
          return;
        }

        // Only merge values if there is an existing value to merge with,
        // and if the value types match, and if the value types are both
        // objects or both arrays. Otherwise just replace the old value
        // with the new value.
        if (
          options[key] &&
          (
            Array.isArray(options[key]) && Array.isArray(value) ||
            isPlainObject(options[key]) && isPlainObject(value)
          )
        ) {
          Object.assign(options, {
            [key]: merge(options[key], newOptions[key])
          });
        } else {
          Object.assign(options, { [key]: newOptions[key] });
        }
      });

    return options;
  }

  bindMainsOnOptions(options, optionsSource) {
    Object
      .keys(options.mains)
      .forEach(key => {
        let value = options.mains[key];

        Reflect.defineProperty(options.mains, key, {
          enumerable: true,
          get() {
            const source = optionsSource &&
              optionsSource.source || options.source;

            return normalizePath(source, value);
          },
          set(newValue) {
            value = newValue;
          }
        });
      });

    this.mainsProxy = new Proxy(options.mains, {
      defineProperty: (target, prop, { value }) => {
        let currentValue = value;

        return Reflect.defineProperty(target, prop, {
          enumerable: true,
          get() {
            const source = optionsSource &&
              optionsSource.source || options.source;

            return normalizePath(source, currentValue);
          },
          set(newValue) {
            currentValue = newValue;
          }
        });
      }
    });
  }

  regexFromExtensions(extensions = this.options.extensions) {
    const exts = extensions.map(ext => ext.replace('.', '\\.'));

    return new RegExp(
      extensions.length === 1 ?
        String.raw`\.${exts[0]}$` :
        String.raw`\.(${exts.join('|')})$`
    );
  }

  register(name, handler) {
    this.outputHandlers.set(name, handler);
  }

  use(middleware, options) {
    if (typeof middleware === 'function') {
      // If middleware is a function, invoke it with the provided options
      middleware(this, options);
    } else if (typeof middleware === 'string') {
      // If middleware is a string, it's a module to require.
      // Require it, then run the results back through .use()
      // with the provided options
      this.use(requireFromRoot(middleware, this.options.root), options);
    } else if (Array.isArray(middleware)) {
      // If middleware is an array, it's a pair of some other
      // middleware type and options
      this.use(...middleware);
    } else if (isPlainObject(middleware)) {
      // If middleware is an object, it could contain other middleware in
      // its "use" property. Run every item in "use" prop back through .use(),
      // plus set any options.
      if (middleware.options) {
        this.options = this.mergeOptions(this.options, middleware.options);
      }

      if (middleware.use) {
        if (Array.isArray(middleware.use)) {
          middleware.use.map(usage => this.use(usage));
        } else {
          this.use(middleware.use);
        }
      }
    }
  }
};
