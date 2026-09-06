/*
 * lowlight, in lamassu's subset: the emitter that builds hast instead of
 * HTML, and `createLowlight`. A fork of lowlight/lib/index.js at the version
 * in VERSION — the class is a constructor function, `Object.hasOwn` is
 * hasOwnProperty, the asserts are gone, and nothing else moved. mdy-docs
 * highlights with exactly this (`createLowlight(common)` in
 * src/parse/highlight.js), so this is the tree it gets.
 *
 * `HighlightJs` is the instance core.js leaves behind; build.mjs puts the two
 * in one scope.
 */

const emptyOptions = {};
const defaultPrefix = 'hljs-';

function createLowlight(grammars) {
  const high = HighlightJs.newInstance();

  if (grammars) {
    register(grammars);
  }

  return {
    highlight,
    highlightAuto,
    listLanguages,
    register,
    registerAlias,
    registered
  };

  function highlight(language, value, options) {
    const settings = options || emptyOptions;
    const prefix =
      typeof settings.prefix === 'string' ? settings.prefix : defaultPrefix;

    if (!high.getLanguage(language)) {
      throw new Error('Unknown language: `' + language + '` is not registered');
    }

    // See: <https://github.com/highlightjs/highlight.js/issues/3621#issuecomment-1528841888>
    high.configure({ __emitter: HastEmitter, classPrefix: prefix });

    const result = high.highlight(value, { ignoreIllegals: true, language });

    // `highlight.js` seems to use this (currently) for broken grammars, so let’s
    // keep it in there just to be sure.
    if (result.errorRaised) {
      throw new Error('Could not highlight with `Highlight.js`', {
        cause: result.errorRaised
      });
    }

    const root = result._emitter.root;
    const data = root.data;
    data.language = result.language;
    data.relevance = result.relevance;

    return root;
  }

  function highlightAuto(value, options) {
    const settings = options || emptyOptions;
    const subset = settings.subset || listLanguages();

    let index = -1;
    let relevance = 0;
    let result;

    while (++index < subset.length) {
      const name = subset[index];

      if (!high.getLanguage(name)) continue;

      const current = highlight(name, value, options);

      if (
        current.data &&
        current.data.relevance !== undefined &&
        current.data.relevance > relevance
      ) {
        relevance = current.data.relevance;
        result = current;
      }
    }

    return (
      result || {
        type: 'root',
        children: [],
        data: { language: undefined, relevance }
      }
    );
  }

  function listLanguages() {
    return high.listLanguages();
  }

  function register(grammarsOrName, grammar) {
    if (typeof grammarsOrName === 'string') {
      high.registerLanguage(grammarsOrName, grammar);
    } else {
      // lamassu: Object.keys, for for…in with Object.hasOwn.
      Object.keys(grammarsOrName).forEach((name) => {
        high.registerLanguage(name, grammarsOrName[name]);
      });
    }
  }

  function registerAlias(aliasesOrName, alias) {
    if (typeof aliasesOrName === 'string') {
      high.registerAliases(
        // Note: copy needed because hljs doesn’t accept readonly arrays yet.
        typeof alias === 'string' ? alias : alias.slice(),
        { languageName: aliasesOrName }
      );
    } else {
      Object.keys(aliasesOrName).forEach((key) => {
        const aliases = aliasesOrName[key];
        high.registerAliases(
          typeof aliases === 'string' ? aliases : aliases.slice(),
          { languageName: key }
        );
      });
    }
  }

  function registered(aliasOrName) {
    return Boolean(high.getLanguage(aliasOrName));
  }
}

/* ---- the emitter ---------------------------------------------------------- */

// lamassu: a constructor function and prototype methods, for the class.
function HastEmitter(options) {
  this.options = options;
  this.root = {
    type: 'root',
    children: [],
    data: { language: undefined, relevance: 0 }
  };
  this.stack = [this.root];
}

HastEmitter.prototype.addText = function (value) {
  if (value === '') return;

  const current = this.stack[this.stack.length - 1];
  const tail = current.children[current.children.length - 1];

  if (tail && tail.type === 'text') {
    tail.value += value;
  } else {
    current.children.push({ type: 'text', value });
  }
};

HastEmitter.prototype.startScope = function (rawName) {
  this.openNode(String(rawName));
};

HastEmitter.prototype.endScope = function () {
  this.closeNode();
};

HastEmitter.prototype.__addSublanguage = function (other, name) {
  const current = this.stack[this.stack.length - 1];
  // Assume only element content.
  const results = other.root.children;

  if (name) {
    current.children.push({
      type: 'element',
      tagName: 'span',
      properties: { className: [name] },
      children: results
    });
  } else {
    current.children.push(...results);
  }
};

HastEmitter.prototype.openNode = function (name) {
  const self = this;
  // First “class” gets the prefix. Rest gets a repeated underscore suffix.
  // See: <https://github.com/highlightjs/highlight.js/commit/51806aa>
  // See: <https://github.com/wooorm/lowlight/issues/43>
  const className = name.split('.').map(function (d, i) {
    return i ? d + '_'.repeat(i) : self.options.classPrefix + d;
  });
  const current = this.stack[this.stack.length - 1];
  const child = {
    type: 'element',
    tagName: 'span',
    properties: { className },
    children: []
  };

  current.children.push(child);
  this.stack.push(child);
};

HastEmitter.prototype.closeNode = function () {
  this.stack.pop();
};

HastEmitter.prototype.finalize = function () {};

HastEmitter.prototype.toHTML = function () {
  return '';
};
