/*
 * highlight.js core, in lamassu's subset of JavaScript.
 *
 * A fork of highlight.js/lib/core.js at the version in VERSION, rewritten
 * construct by construct into what lamassu runs — and NOTHING else changed:
 * the mode compiler, the scanner, keyword handling, `illegal`, sub-languages
 * and relevance are upstream's, line for line where the subset allows, so the
 * tree this produces for a fence is the tree lowlight produces in node. That
 * is checked, not assumed: `make check-highlight` runs both over every source
 * file in the tree and diffs.
 *
 * What lamassu does not have, and what stands in for it here (each site is
 * marked `lamassu:`):
 *
 *   classes, getters          constructor functions and prototype methods
 *   Object.create             a constructor whose prototype is the mode —
 *                             see frame(); the parent link is an own property
 *   for…in                    Object.keys
 *   Symbol                    an object as the sentinel
 *   Function.prototype.bind   a closure
 *   Array.prototype.splice    slice, or an indexed write
 *   Object.getOwnPropertyNames  Object.keys
 *   console                   nothing — errors and warnings are swallowed
 *   the DOM                   dropped: highlightElement, highlightAll and the
 *                             plugin hooks have no work to do on a tree
 *
 * And one substitution that is about correctness rather than syntax:
 * upstream keeps keyword tables and language registries in null-prototype
 * objects, so that a word like `constructor` cannot hit Object.prototype.
 * lamassu has no null-prototype objects; those tables are Maps here.
 *
 * The emitter is not here. Upstream's builds HTML; the one this fork exists
 * for builds hast, and lives in lowlight.js next to this file.
 */

/* ---- deep freeze ---------------------------------------------------------- */

function deepFreeze(obj) {
  // lamassu: no Map/Set in MODES, so upstream's instanceof branches go.
  Object.freeze(obj);
  Object.keys(obj).forEach((name) => {
    const prop = obj[name];
    const type = typeof prop;
    if ((type === 'object' || type === 'function') && prop !== null && !Object.isFrozen(prop)) {
      deepFreeze(prop);
    }
  });
  return obj;
}

/* ---- Response ------------------------------------------------------------- */

// lamassu: a constructor function rather than a class.
function Response(mode) {
  if (mode.data === undefined) mode.data = {};
  this.data = mode.data;
  this.isMatchIgnored = false;
}
Response.prototype.ignoreMatch = function () {
  this.isMatchIgnored = true;
};

/* ---- utils ---------------------------------------------------------------- */

function escapeHTML(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * performs a shallow merge of multiple objects into one
 */
function inherit$1(original, ...objects) {
  // lamassu: a plain object and Object.keys, for Object.create(null) and for…in.
  const result = {};
  Object.keys(original).forEach((key) => { result[key] = original[key]; });
  objects.forEach(function (obj) {
    Object.keys(obj).forEach((key) => { result[key] = obj[key]; });
  });
  return result;
}

/* ---- regex helpers -------------------------------------------------------- */

function source(re) {
  if (!re) return null;
  if (typeof re === "string") return re;
  return re.source;
}

function lookahead(re) {
  return concat('(?=', re, ')');
}

function anyNumberOfTimes(re) {
  return concat('(?:', re, ')*');
}

function optional(re) {
  return concat('(?:', re, ')?');
}

function concat(...args) {
  const joined = args.map((x) => source(x)).join("");
  return joined;
}

function stripOptionsFromArgs(args) {
  const opts = args[args.length - 1];
  if (typeof opts === 'object' && opts.constructor === Object) {
    args.pop(); // lamassu: for args.splice(args.length - 1, 1)
    return opts;
  } else {
    return {};
  }
}

/**
 * Any of the passed expresssions may match
 */
function either(...args) {
  const opts = stripOptionsFromArgs(args);
  const joined = '('
    + (opts.capture ? "" : "?:")
    + args.map((x) => source(x)).join("|") + ")";
  return joined;
}

function countMatchGroups(re) {
  return (new RegExp(re.toString() + '|')).exec('').length - 1;
}

/**
 * Does lexeme start with a regular expression match at the beginning
 */
function startsWith(re, lexeme) {
  const match = re && re.exec(lexeme);
  return match && match.index === 0;
}

// BACKREF_RE matches an open parenthesis or backreference. To avoid
// an incorrect parse, it additionally matches the following:
// - [...] elements, where the meaning of parentheses and escapes change
// - other escape sequences, so we do not misparse escape sequences as
//   interesting elements
// - non-matching or lookahead parentheses, which do not capture. These
//   follow the '(' with a '?'.
const BACKREF_RE = /\[(?:[^\\\]]|\\.)*\]|\(\??|\\([1-9][0-9]*)|\\./;

// **INTERNAL** Not intended for outside usage
// join logically computes regexps.join(separator), but fixes the
// backreferences so they continue to match.
// it also places each individual regular expression into it's own
// match group, keeping track of the sequencing of those match groups
// is currently an exercise for the caller. :-)
function _rewriteBackreferences(regexps, { joinWith }) {
  let numCaptures = 0;

  return regexps.map((regex) => {
    numCaptures += 1;
    const offset = numCaptures;
    let re = source(regex);
    let out = '';

    while (re.length > 0) {
      const match = BACKREF_RE.exec(re);
      if (!match) {
        out += re;
        break;
      }
      out += re.substring(0, match.index);
      re = re.substring(match.index + match[0].length);
      if (match[0][0] === '\\' && match[1]) {
        // Adjust the backreference.
        out += '\\' + String(Number(match[1]) + offset);
      } else {
        out += match[0];
        if (match[0] === '(') {
          numCaptures++;
        }
      }
    }
    return out;
  }).map(re => `(${re})`).join(joinWith);
}

/* ---- common regexps and modes --------------------------------------------- */

const MATCH_NOTHING_RE = /\b\B/;
const IDENT_RE = '[a-zA-Z]\\w*';
const UNDERSCORE_IDENT_RE = '[a-zA-Z_]\\w*';
const NUMBER_RE = '\\b\\d+(\\.\\d+)?';
const C_NUMBER_RE = '(-?)(\\b0[xX][a-fA-F0-9]+|(\\b\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?)'; // 0x..., 0..., decimal, float
const BINARY_NUMBER_RE = '\\b(0b[01]+)'; // 0b...
const RE_STARTERS_RE = '!|!=|!==|%|%=|&|&&|&=|\\*|\\*=|\\+|\\+=|,|-|-=|/=|/|:|;|<<|<<=|<=|<|===|==|=|>>>=|>>=|>=|>>>|>>|>|\\?|\\[|\\{|\\(|\\^|\\^=|\\||\\|=|\\|\\||~';

const SHEBANG = (opts = {}) => {
  const beginShebang = /^#![ ]*\//;
  if (opts.binary) {
    opts.begin = concat(
      beginShebang,
      /.*\b/,
      opts.binary,
      /\b.*/);
  }
  return inherit$1({
    scope: 'meta',
    begin: beginShebang,
    end: /$/,
    relevance: 0,
    "on:begin": (m, resp) => {
      if (m.index !== 0) resp.ignoreMatch();
    }
  }, opts);
};

// Common modes
const BACKSLASH_ESCAPE = {
  begin: '\\\\[\\s\\S]', relevance: 0
};
const APOS_STRING_MODE = {
  scope: 'string',
  begin: '\'',
  end: '\'',
  illegal: '\\n',
  contains: [BACKSLASH_ESCAPE]
};
const QUOTE_STRING_MODE = {
  scope: 'string',
  begin: '"',
  end: '"',
  illegal: '\\n',
  contains: [BACKSLASH_ESCAPE]
};
const PHRASAL_WORDS_MODE = {
  begin: /\b(a|an|the|are|I'm|isn't|don't|doesn't|won't|but|just|should|pretty|simply|enough|gonna|going|wtf|so|such|will|you|your|they|like|more)\b/
};
/**
 * Creates a comment mode
 */
const COMMENT = function (begin, end, modeOptions = {}) {
  const mode = inherit$1(
    {
      scope: 'comment',
      begin,
      end,
      contains: []
    },
    modeOptions
  );
  mode.contains.push({
    scope: 'doctag',
    // hack to avoid the space from being included. the space is necessary to
    // match here to prevent the plain text rule below from gobbling up doctags
    begin: '[ ]*(?=(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):)',
    end: /(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):/,
    excludeBegin: true,
    relevance: 0
  });
  const ENGLISH_WORD = either(
    // list of common 1 and 2 letter words in English
    "I",
    "a",
    "is",
    "so",
    "us",
    "to",
    "at",
    "if",
    "in",
    "it",
    "on",
    // note: this is not an exhaustive list of contractions, just popular ones
    /[A-Za-z]+['](d|ve|re|ll|t|s|n)/, // contractions - can't we'd they're let's, etc
    /[A-Za-z]+[-][a-z]+/, // `no-way`, etc.
    /[A-Za-z][a-z]{2,}/ // allow capitalized words at beginning of sentences
  );
  // looking like plain text, more likely to be a comment
  mode.contains.push(
    {
      // this tries to find sequences of 3 english words in a row (without any
      // "programming" type syntax) this gives us a strong signal that we've
      // TRULY found a comment - vs perhaps scanning with the wrong language.
      // It's possible to find something that LOOKS like the start of the
      // comment - but then if there is no readable text - good chance it is a
      // false match and not a comment.
      //
      // for a visual example please see:
      // https://github.com/highlightjs/highlight.js/issues/2827
      begin: concat(
        /[ ]+/, // necessary to prevent us gobbling up doctags like /* @author Bob Mcgill */
        '(',
        ENGLISH_WORD,
        /[.]?[:]?([.][ ]|[ ])/,
        '){3}') // look for 3 words in a row
    }
  );
  return mode;
};
const C_LINE_COMMENT_MODE = COMMENT('//', '$');
const C_BLOCK_COMMENT_MODE = COMMENT('/\\*', '\\*/');
const HASH_COMMENT_MODE = COMMENT('#', '$');
const NUMBER_MODE = {
  scope: 'number',
  begin: NUMBER_RE,
  relevance: 0
};
const C_NUMBER_MODE = {
  scope: 'number',
  begin: C_NUMBER_RE,
  relevance: 0
};
const BINARY_NUMBER_MODE = {
  scope: 'number',
  begin: BINARY_NUMBER_RE,
  relevance: 0
};
const REGEXP_MODE = {
  scope: "regexp",
  begin: /\/(?=[^/\n]*\/)/,
  end: /\/[gimuy]*/,
  contains: [
    BACKSLASH_ESCAPE,
    {
      begin: /\[/,
      end: /\]/,
      relevance: 0,
      contains: [BACKSLASH_ESCAPE]
    }
  ]
};
const TITLE_MODE = {
  scope: 'title',
  begin: IDENT_RE,
  relevance: 0
};
const UNDERSCORE_TITLE_MODE = {
  scope: 'title',
  begin: UNDERSCORE_IDENT_RE,
  relevance: 0
};
const METHOD_GUARD = {
  // excludes method names from keyword processing
  begin: '\\.\\s*' + UNDERSCORE_IDENT_RE,
  relevance: 0
};

/**
 * Adds end same as begin mechanics to a mode
 *
 * Your mode must include at least a single () match group as that first match
 * group is what is used for comparison
 */
const END_SAME_AS_BEGIN = function (mode) {
  return Object.assign(mode,
    {
      'on:begin': (m, resp) => { resp.data._beginMatch = m[1]; },
      'on:end': (m, resp) => { if (resp.data._beginMatch !== m[1]) resp.ignoreMatch(); }
    });
};

// lamassu: a plain object; upstream's has a null prototype, which changes
// nothing that is read from it.
const MODES = Object.freeze({
  APOS_STRING_MODE: APOS_STRING_MODE,
  BACKSLASH_ESCAPE: BACKSLASH_ESCAPE,
  BINARY_NUMBER_MODE: BINARY_NUMBER_MODE,
  BINARY_NUMBER_RE: BINARY_NUMBER_RE,
  COMMENT: COMMENT,
  C_BLOCK_COMMENT_MODE: C_BLOCK_COMMENT_MODE,
  C_LINE_COMMENT_MODE: C_LINE_COMMENT_MODE,
  C_NUMBER_MODE: C_NUMBER_MODE,
  C_NUMBER_RE: C_NUMBER_RE,
  END_SAME_AS_BEGIN: END_SAME_AS_BEGIN,
  HASH_COMMENT_MODE: HASH_COMMENT_MODE,
  IDENT_RE: IDENT_RE,
  MATCH_NOTHING_RE: MATCH_NOTHING_RE,
  METHOD_GUARD: METHOD_GUARD,
  NUMBER_MODE: NUMBER_MODE,
  NUMBER_RE: NUMBER_RE,
  PHRASAL_WORDS_MODE: PHRASAL_WORDS_MODE,
  QUOTE_STRING_MODE: QUOTE_STRING_MODE,
  REGEXP_MODE: REGEXP_MODE,
  RE_STARTERS_RE: RE_STARTERS_RE,
  SHEBANG: SHEBANG,
  TITLE_MODE: TITLE_MODE,
  UNDERSCORE_IDENT_RE: UNDERSCORE_IDENT_RE,
  UNDERSCORE_TITLE_MODE: UNDERSCORE_TITLE_MODE
});

/* ---- compiler extensions -------------------------------------------------- */

// Grammar extensions / plugins
// See: https://github.com/highlightjs/highlight.js/issues/2833

/**
 * Skip a match if it has a preceding dot
 *
 * This is used for `beginKeywords` to prevent matching expressions such as
 * `bob.keyword.do()`. The mode compiler automatically wires this up as a
 * special _internal_ 'on:begin' callback for modes with `beginKeywords`
 */
function skipIfHasPrecedingDot(match, response) {
  const before = match.input[match.index - 1];
  if (before === ".") {
    response.ignoreMatch();
  }
}

function scopeClassName(mode, _parent) {
  if (mode.className !== undefined) {
    mode.scope = mode.className;
    delete mode.className;
  }
}

/**
 * `beginKeywords` syntactic sugar
 */
function beginKeywords(mode, parent) {
  if (!parent) return;
  if (!mode.beginKeywords) return;

  // for languages with keywords that include non-word characters checking for
  // a word boundary is not sufficient, so instead we check for a word boundary
  // or whitespace - this does no harm in any case since our keyword engine
  // doesn't allow spaces in keywords anyways and we still check for the boundary
  // first
  mode.begin = '\\b(' + mode.beginKeywords.split(' ').join('|') + ')(?!\\.)(?=\\b|\\s)';
  mode.__beforeBegin = skipIfHasPrecedingDot;
  mode.keywords = mode.keywords || mode.beginKeywords;
  delete mode.beginKeywords;

  // prevents double relevance, the keywords themselves provide
  // relevance, the mode doesn't need to double it
  if (mode.relevance === undefined) mode.relevance = 0;
}

/**
 * Allow `illegal` to contain an array of illegal values
 */
function compileIllegal(mode, _parent) {
  if (!Array.isArray(mode.illegal)) return;

  mode.illegal = either(...mode.illegal);
}

/**
 * `match` to match a single expression for readability
 */
function compileMatch(mode, _parent) {
  if (!mode.match) return;
  if (mode.begin || mode.end) throw new Error("begin & end are not supported with match");

  mode.begin = mode.match;
  delete mode.match;
}

/**
 * provides the default 1 relevance to all modes
 */
function compileRelevance(mode, _parent) {
  if (mode.relevance === undefined) mode.relevance = 1;
}

// allow beforeMatch to act as a "qualifier" for the match
// the full match begin must be [beforeMatch][begin]
const beforeMatchExt = (mode, parent) => {
  if (!mode.beforeMatch) return;
  // starts conflicts with endsParent which we need to make sure the child
  // rule is not matched multiple times
  if (mode.starts) throw new Error("beforeMatch cannot be used with starts");

  const originalMode = Object.assign({}, mode);
  Object.keys(mode).forEach((key) => { delete mode[key]; });

  mode.keywords = originalMode.keywords;
  mode.begin = concat(originalMode.beforeMatch, lookahead(originalMode.begin));
  mode.starts = {
    relevance: 0,
    contains: [
      Object.assign(originalMode, { endsParent: true })
    ]
  };
  mode.relevance = 0;

  delete originalMode.beforeMatch;
};

/* ---- keywords ------------------------------------------------------------- */

// keywords that should have no default relevance value
const COMMON_KEYWORDS = [
  'of',
  'and',
  'for',
  'in',
  'not',
  'or',
  'if',
  'then',
  'parent', // common variable name
  'list', // common variable name
  'value' // common variable name
];

const DEFAULT_KEYWORD_SCOPE = "keyword";

/**
 * Given raw keywords from a language definition, compile them.
 *
 * lamassu: the compiled table is a Map. Upstream's is a null-prototype
 * object so that `constructor` or `toString` in the code cannot find
 * Object.prototype and be taken for a keyword; a Map is the same guarantee.
 */
function compileKeywords(rawKeywords, caseInsensitive, scopeName = DEFAULT_KEYWORD_SCOPE, winners = null) {
  const compiledKeywords = new Map();

  // input can be a string of keywords, an array of keywords, or a object with
  // named keys representing scopeName (which can then point to a string or array)
  if (typeof rawKeywords === 'string') {
    compileList(scopeName, rawKeywords.split(" "));
  } else if (Array.isArray(rawKeywords)) {
    compileList(scopeName, rawKeywords);
  } else {
    // lamassu: upstream's last scope in source order wins a word listed
    // twice; Object.keys here is hash order, so the winner comes from the
    // table sync.mjs generated (KEYWORD_SCOPES) — and only for a word this
    // object really lists in two scopes, counted as they merge.
    const scopesSeen = new Map();
    Object.keys(rawKeywords).forEach(function (scopeName) {
      // collapse all our objects back into the parent object
      compileKeywords(rawKeywords[scopeName], caseInsensitive, scopeName)
        .forEach((value, key) => {
          compiledKeywords.set(key, value);
          scopesSeen.set(key, (scopesSeen.get(key) || 0) + 1);
        });
    });
    if (winners) {
      Object.keys(winners).forEach((word) => {
        const key = caseInsensitive ? word.toLowerCase() : word;
        if ((scopesSeen.get(key) || 0) < 2) return;
        const [scope, entry] = winners[word];
        compiledKeywords.set(key, [scope, scoreForKeyword(key, entry.split('|')[1])]);
      });
    }
  }
  return compiledKeywords;

  // ---

  /**
   * Compiles an individual list of keywords
   *
   * Ex: "for if when while|5"
   */
  function compileList(scopeName, keywordList) {
    if (caseInsensitive) {
      keywordList = keywordList.map(x => x.toLowerCase());
    }
    keywordList.forEach(function (keyword) {
      const pair = keyword.split('|');
      compiledKeywords.set(pair[0], [scopeName, scoreForKeyword(pair[0], pair[1])]);
    });
  }
}

/**
 * Returns the proper score for a given keyword
 *
 * Also takes into account comment keywords, which will be scored 0 UNLESS
 * another score has been manually assigned.
 */
function scoreForKeyword(keyword, providedScore) {
  // manual scores always win over common keywords
  // so you can force a score of 1 if you really insist
  if (providedScore) {
    return Number(providedScore);
  }

  return commonKeyword(keyword) ? 0 : 1;
}

/**
 * Determines if a given keyword is common or not
 */
function commonKeyword(keyword) {
  return COMMON_KEYWORDS.includes(keyword.toLowerCase());
}

/* ---- logging -------------------------------------------------------------- */

// lamassu: there is no console. Upstream logs a grammar's errors and its own
// deprecations; here they are swallowed, and a grammar that fails to register
// is replaced with plain text exactly as upstream's SAFE_MODE does.
const error = (_message) => {};
const warn = (_message, ..._args) => {};
const deprecated = (_version, _message) => {};

/* ---- multi-class scopes --------------------------------------------------- */

const MultiClassError = new Error();

/**
 * Renumbers labeled scope names to account for additional inner match
 * groups that otherwise would break everything.
 *
 * Lets say we 3 match scopes:
 *
 *   { 1 => ..., 2 => ..., 3 => ... }
 *
 * So what we need is a clean match like this:
 *
 *   (a)(b)(c) => [ "a", "b", "c" ]
 *
 * But this falls apart with inner match groups:
 *
 * (a)(((b)))(c) => ["a", "b", "b", "b", "c" ]
 *
 * Our scopes are now "out of alignment" and we're repeating `b` 3 times.
 * What needs to happen is the numbers are remapped:
 *
 *   { 1 => ..., 2 => ..., 5 => ... }
 *
 * We also need to know that the ONLY groups that should be output
 * are 1, 2, and 5.  This function handles this behavior.
 */
function remapScopeNames(mode, regexes, { key }) {
  let offset = 0;
  const scopeNames = mode[key];
  const emit = {};
  const positions = {};

  for (let i = 1; i <= regexes.length; i++) {
    positions[i + offset] = scopeNames[i];
    emit[i + offset] = true;
    offset += countMatchGroups(regexes[i - 1]);
  }
  // we use _emit to keep track of which match groups are "top-level" to avoid double
  // output from inside match groups
  mode[key] = positions;
  mode[key]._emit = emit;
  mode[key]._multi = true;
}

function beginMultiClass(mode) {
  if (!Array.isArray(mode.begin)) return;

  if (mode.skip || mode.excludeBegin || mode.returnBegin) {
    error("skip, excludeBegin, returnBegin not compatible with beginScope: {}");
    throw MultiClassError;
  }

  if (typeof mode.beginScope !== "object" || mode.beginScope === null) {
    error("beginScope must be object");
    throw MultiClassError;
  }

  remapScopeNames(mode, mode.begin, { key: "beginScope" });
  mode.begin = _rewriteBackreferences(mode.begin, { joinWith: "" });
}

function endMultiClass(mode) {
  if (!Array.isArray(mode.end)) return;

  if (mode.skip || mode.excludeEnd || mode.returnEnd) {
    error("skip, excludeEnd, returnEnd not compatible with endScope: {}");
    throw MultiClassError;
  }

  if (typeof mode.endScope !== "object" || mode.endScope === null) {
    error("endScope must be object");
    throw MultiClassError;
  }

  remapScopeNames(mode, mode.end, { key: "endScope" });
  mode.end = _rewriteBackreferences(mode.end, { joinWith: "" });
}

/**
 * this exists only to allow `scope: {}` to be used beside `match:`
 * Otherwise `beginScope` would necessary and that would look weird

  {
    match: [ /def/, /\w+/ ]
    scope: { 1: "keyword" , 2: "title" }
  }
 */
function scopeSugar(mode) {
  if (mode.scope && typeof mode.scope === "object" && mode.scope !== null) {
    mode.beginScope = mode.scope;
    delete mode.scope;
  }
}

function MultiClass(mode) {
  scopeSugar(mode);

  if (typeof mode.beginScope === "string") {
    mode.beginScope = { _wrap: mode.beginScope };
  }
  if (typeof mode.endScope === "string") {
    mode.endScope = { _wrap: mode.endScope };
  }

  beginMultiClass(mode);
  endMultiClass(mode);
}

/* ---- compilation ---------------------------------------------------------- */

/**
 * Compiles a language definition result
 *
 * Given the raw result of a language definition (Language), compiles this so
 * that it is ready for highlighting code.
 */
function compileLanguage(language, regexCache) {
  // lamassu: see compileKeywords. Keyed by the name the grammar was
  // registered under, which defineLanguage records.
  const winners = (typeof KEYWORD_SCOPES === 'object' && KEYWORD_SCOPES !== null && KEYWORD_SCOPES[language.__key]) || null;

  /**
   * Builds a regex with the case sensitivity of the current language
   *
   * lamassu: one object per distinct pattern and flags, shared across every
   * mode and language that wants it. A compiled regex costs the engine 21 KB
   * and the VM caps how many are alive, and the same few patterns — an
   * escape, a string, a comment — recur in hundreds of modes. Sharing is
   * safe because every user sets lastIndex before exec and reads it
   * straight after, and nothing else about a RegExp is state.
   */
  function langRe(value, global) {
    const flags = 'm'
      + (language.case_insensitive ? 'i' : '')
      + (language.unicodeRegex ? 'u' : '')
      + (global ? 'g' : '');
    const key = flags + '\u0000' + source(value);
    let re = regexCache.get(key);
    if (!re) {
      re = new RegExp(source(value), flags);
      regexCache.set(key, re);
    }
    return re;
  }

  /**
    Stores multiple regular expressions and allows you to quickly search for
    them all in a string simultaneously - returning the first match.

    Upstream does this by creating a huge (a|b|c) regex - each individual item
    wrapped with () and joined by `|` - using match groups to track position.

    lamassu: NOT here. That alternation is one pattern holding every class of
    every rule, and baru-re compiles at most 256 classes into a pattern —
    swift's identifier ranges alone put a mode's alternation past that. So
    each rule keeps its own regex and exec() asks each for its next match at
    or after lastIndex, taking the earliest, ties to the earlier rule. That is
    what the alternation computes: a regex finds the leftmost position with
    a match, and at one position tries the alternatives in order.

    It stays linear because a rule's next match is memoised. A match is a
    fact about the string, not about where the scan started — lookbehind and
    `\b` read the whole input either way — so the leftmost match at or after
    f, found at p, is also the leftmost at or after any f' with f <= f' <= p.
    A rule is asked again only when the scan passes p, or starts again
    before f: matchers belong to compiled modes and outlive a highlight
    call, so the next call over the same string starts at 0 with the
    previous call's answers still cached.

    The match object itself (the result of `Regex.exec`) is returned but also
    enhanced by merging in any meta-data that was registered with the regex.
    This is how we keep track of which mode matched, and what type of rule
    (`illegal`, `begin`, end, etc).
  */
  function MultiRegex() {
    this.rules = [];
    this.position = 0;
    this.lastIndex = 0;
  }

  MultiRegex.prototype.addRule = function (re, opts) {
    opts.position = this.position++;
    this.rules.push({ re: langRe(re, true), opts, input: null, from: 0, at: -1, match: null });
  };

  MultiRegex.prototype.compile = function () {
    if (this.rules.length === 0) {
      // avoids the need to check length every time exec is called
      this.exec = () => null;
    }
    this.lastIndex = 0;
  };

  MultiRegex.prototype.exec = function (s) {
    const from = this.lastIndex;
    let best = null;
    for (const rule of this.rules) {
      if (rule.input !== s || from < rule.from || rule.at < from) {
        rule.re.lastIndex = from;
        rule.match = rule.re.exec(s);
        rule.input = s;
        rule.from = from;
        // No match from here means none further on either, and Infinity
        // is never "before from" again.
        rule.at = rule.match ? rule.match.index : Infinity;
      }
      if (rule.match && (best === null || rule.at < best.at)) best = rule;
    }
    if (!best) { return null; }

    // A copy: the memoised match must not carry this call's meta-data.
    const match = best.match.slice();
    match.index = best.match.index;
    match.input = s;

    return Object.assign(match, best.opts);
  };

  /*
    Created to solve the key deficiently with MultiRegex - there is no way to
    test for multiple matches at a single location.  Why would we need to do
    that?  In the future a more dynamic engine will allow certain matches to be
    ignored.  An example: if we matched say the 3rd regex in a large group but
    decided to ignore it - we'd need to started testing again at the 4th
    regex... but MultiRegex itself gives us no real way to do that.

    So what this class creates MultiRegexs on the fly for whatever search
    position they are needed.

    NOTE: These additional MultiRegex objects are created dynamically.  For most
    grammars most of the time we will never actually need anything more than the
    first MultiRegex - so this shouldn't have too much overhead.

    Say this is our search group, and we match regex3, but wish to ignore it.

      regex1 | regex2 | regex3 | regex4 | regex5    ' ie, startAt = 0

    What we need is a new MultiRegex that only includes the remaining
    possibilities:

      regex4 | regex5                               ' ie, startAt = 3

    This class wraps all that complexity up in a simple API... `startAt` decides
    where in the array of expressions to start doing the matching. It
    auto-increments, so if a match is found at position 2, then startAt will be
    set to 3.  If the end is reached startAt will return to 0.

    MOST of the time the parser will be setting startAt manually to 0.
  */
  function ResumableMultiRegex() {
    this.rules = [];
    this.multiRegexes = [];
    this.count = 0;

    this.lastIndex = 0;
    this.regexIndex = 0;
  }

  ResumableMultiRegex.prototype.getMatcher = function (index) {
    if (this.multiRegexes[index]) return this.multiRegexes[index];

    const matcher = new MultiRegex();
    this.rules.slice(index).forEach(([re, opts]) => matcher.addRule(re, opts));
    matcher.compile();
    this.multiRegexes[index] = matcher;
    return matcher;
  };

  ResumableMultiRegex.prototype.resumingScanAtSamePosition = function () {
    return this.regexIndex !== 0;
  };

  ResumableMultiRegex.prototype.considerAll = function () {
    this.regexIndex = 0;
  };

  ResumableMultiRegex.prototype.addRule = function (re, opts) {
    this.rules.push([re, opts]);
    if (opts.type === "begin") this.count++;
  };

  ResumableMultiRegex.prototype.exec = function (s) {
    const m = this.getMatcher(this.regexIndex);
    m.lastIndex = this.lastIndex;
    let result = m.exec(s);

    // The following is because we have no easy way to say "resume scanning at the
    // existing position but also skip the current rule ONLY". What happens is
    // all prior rules are also skipped which can result in matching the wrong
    // thing. Example of matching "booger":

    // our matcher is [string, "booger", number]
    //
    // ....booger....

    // if "booger" is ignored then we'd really need a regex to scan from the
    // SAME position for only: [string, number] but ignoring "booger" (if it
    // was the first match), a simple resume would scan ahead who knows how
    // far looking only for "number", ignoring potential string matches (or
    // future "booger" matches that might be valid.)

    // So what we do: We execute two matchers, one resuming at the same
    // position, but the second full matcher starting at the position after:

    //     /--- resume first regex match here (for [number])
    //     |/---- full match here for [string, "booger", number]
    //     vv
    // ....booger....

    // Which ever results in a match first is then used. So this 3-4 step
    // process essentially allows us to say "match at this position, excluding
    // a prior rule that was ignored".
    //
    // 1. Match "booger" first, ignore. Also proves that [string] does non match.
    // 2. Resume matching for [number]
    // 3. Match at index + 1 for [string, "booger", number]
    // 4. If #2 and #3 result in matches, which came first?
    if (this.resumingScanAtSamePosition()) {
      if (result && result.index === this.lastIndex) ; else { // use the second matcher result
        const m2 = this.getMatcher(0);
        m2.lastIndex = this.lastIndex + 1;
        result = m2.exec(s);
      }
    }

    if (result) {
      this.regexIndex += result.position + 1;
      if (this.regexIndex === this.count) {
        // wrap-around to considering all matches again
        this.considerAll();
      }
    }

    return result;
  };

  /**
   * Given a mode, builds a huge ResumableMultiRegex that can be used to walk
   * the content and find matches.
   */
  function buildModeRegex(mode) {
    const mm = new ResumableMultiRegex();

    mode.contains.forEach(term => mm.addRule(term.begin, { rule: term, type: "begin" }));

    if (mode.terminatorEnd) {
      mm.addRule(mode.terminatorEnd, { type: "end" });
    }
    if (mode.illegal) {
      mm.addRule(mode.illegal, { type: "illegal" });
    }

    return mm;
  }

  /**
   * Compiles an individual mode
   *
   * This can raise an error if the mode contains certain detectable known logic
   * issues.
   */
  function compileMode(mode, parent) {
    const cmode = mode;
    if (mode.isCompiled) return cmode;

    [
      scopeClassName,
      // do this early so compiler extensions generally don't have to worry about
      // the distinction between match/begin
      compileMatch,
      MultiClass,
      beforeMatchExt
    ].forEach(ext => ext(mode, parent));

    language.compilerExtensions.forEach(ext => ext(mode, parent));

    // __beforeBegin is considered private API, internal use only
    mode.__beforeBegin = null;

    [
      beginKeywords,
      // do this later so compiler extensions that come earlier have access to the
      // raw array if they wanted to perhaps manipulate it, etc.
      compileIllegal,
      // default to 1 relevance if not specified
      compileRelevance
    ].forEach(ext => ext(mode, parent));

    mode.isCompiled = true;

    let keywordPattern = null;
    if (typeof mode.keywords === "object" && mode.keywords.$pattern) {
      // we need a copy because keywords might be compiled multiple times
      // so we can't go deleting $pattern from the original on the first
      // pass
      mode.keywords = Object.assign({}, mode.keywords);
      keywordPattern = mode.keywords.$pattern;
      delete mode.keywords.$pattern;
    }
    keywordPattern = keywordPattern || /\w+/;

    if (mode.keywords) {
      mode.keywords = compileKeywords(mode.keywords, language.case_insensitive, DEFAULT_KEYWORD_SCOPE, winners);
    }

    cmode.keywordPatternRe = langRe(keywordPattern, true);

    if (parent) {
      if (!mode.begin) mode.begin = /\B|\b/;
      cmode.beginRe = langRe(cmode.begin);
      if (!mode.end && !mode.endsWithParent) mode.end = /\B|\b/;
      if (mode.end) cmode.endRe = langRe(cmode.end);
      cmode.terminatorEnd = source(cmode.end) || '';
      if (mode.endsWithParent && parent.terminatorEnd) {
        cmode.terminatorEnd += (mode.end ? '|' : '') + parent.terminatorEnd;
      }
    }
    if (mode.illegal) cmode.illegalRe = langRe(mode.illegal);
    if (!mode.contains) mode.contains = [];

    mode.contains = [].concat(...mode.contains.map(function (c) {
      return expandOrCloneMode(c === 'self' ? mode : c);
    }));
    mode.contains.forEach(function (c) { compileMode(c, cmode); });

    if (mode.starts) {
      compileMode(mode.starts, parent);
    }

    cmode.matcher = buildModeRegex(cmode);
    return cmode;
  }

  if (!language.compilerExtensions) language.compilerExtensions = [];

  // self is not valid at the top-level
  if (language.contains && language.contains.includes('self')) {
    throw new Error("ERR: contains `self` is not supported at the top-level of a language.  See documentation.");
  }

  // we need a null object, which inherit will guarantee
  language.classNameAliases = inherit$1(language.classNameAliases || {});

  return compileMode(language);
}

/**
 * Determines if a mode has a dependency on it's parent or not
 *
 * If a mode does have a parent dependency then often we need to clone it if
 * it's used in multiple places so that each copy points to the correct parent,
 * where-as modes without a parent can often safely be re-used at the bottom of
 * a mode chain.
 */
function dependencyOnParent(mode) {
  if (!mode) return false;

  return mode.endsWithParent || dependencyOnParent(mode.starts);
}

/**
 * Expands a mode or clones it if necessary
 *
 * This is necessary for modes with parental dependenceis (see notes on
 * `dependencyOnParent`) and for nodes that have `variants` - which must then be
 * exploded into their own individual modes at compile time.
 */
function expandOrCloneMode(mode) {
  if (mode.variants && !mode.cachedVariants) {
    mode.cachedVariants = mode.variants.map(function (variant) {
      return inherit$1(mode, { variants: null }, variant);
    });
  }

  // EXPAND
  // if we have variants then essentially "replace" the mode with the variants
  // this happens in compileMode, where this function is called from
  if (mode.cachedVariants) {
    return mode.cachedVariants;
  }

  // CLONE
  // if we have dependencies on parents then we need a unique
  // instance of ourselves, so we can be reused with many
  // different parents without issue
  if (dependencyOnParent(mode)) {
    return inherit$1(mode, { starts: mode.starts ? inherit$1(mode.starts) : null });
  }

  if (Object.isFrozen(mode)) {
    return inherit$1(mode);
  }

  // no special dependency issues, just return ourselves
  return mode;
}

/* ---- the highlighter ------------------------------------------------------ */

const version = "11.11.2";

const escape = escapeHTML;
const inherit = inherit$1;
const NO_MATCH = {}; // lamassu: an object as the sentinel, for Symbol("nomatch")
const MAX_KEYWORD_HITS = 7;

/**
 * lamassu: what `Object.create(mode, { parent: { value: top } })` built — an
 * object whose prototype is the compiled mode, with `parent` as its own
 * property. A constructor whose prototype is the mode is the same object.
 */
function frame(mode, parent) {
  function Frame() {}
  Frame.prototype = mode;
  const f = new Frame();
  f.parent = parent;
  return f;
}

/**
 * @param {any} hljs - object that is extended (legacy)
 */
const HLJS = function (hljs) {
  // Global internal variables used within the highlight.js library.
  // lamassu: Maps, for upstream's null-prototype objects — a language named
  // `constructor` must not find Object.prototype.
  const languages = new Map();
  const aliases = new Map();
  /* lamassu: a grammar's definition is not run at registration but on first
   * use — running one evaluates every regex literal in it, and the VM caps
   * how many are alive, so 37 grammars registered up front are a thousand
   * regexes before a line is highlighted. The aliases a definition would
   * declare come from ALIASES, generated by sync.mjs from the same
   * grammars, so a name resolves before its grammar has run. */
  const pending = new Map();
  const regexCache = new Map();

  // safe/production mode - swallows more errors, tries to keep running
  // even if a single syntax or parse hits a fatal error
  let SAFE_MODE = true;
  const LANGUAGE_NOT_FOUND = "Could not find the language '{}', did you forget to load/include a language module?";
  const PLAINTEXT_LANGUAGE = { disableAutodetect: true, name: 'Plain text', contains: [] };

  // Global options used when within external APIs. This is modified when
  // calling the `hljs.configure` function.
  let options = {
    ignoreUnescapedHTML: false,
    throwUnescapedHTML: false,
    noHighlightRe: /^(no-?highlight)$/i,
    languageDetectRe: /\blang(?:uage)?-([\w-]+)\b/i,
    classPrefix: 'hljs-',
    cssSelector: 'pre code',
    languages: null,
    // lamassu: no default emitter. Upstream's builds HTML; the caller sets
    // the one that builds hast (lowlight.js) through configure().
    __emitter: null
  };

  /**
   * Core highlighting function.
   *
   * OLD API
   * highlight(lang, code, ignoreIllegals, continuation)
   *
   * NEW API
   * highlight(code, {lang, ignoreIllegals})
   */
  function highlight(codeOrLanguageName, optionsOrCode, ignoreIllegals) {
    let code = "";
    let languageName = "";
    if (typeof optionsOrCode === "object") {
      code = codeOrLanguageName;
      ignoreIllegals = optionsOrCode.ignoreIllegals;
      languageName = optionsOrCode.language;
    } else {
      // old API
      deprecated("10.7.0", "highlight(lang, code, ...args) has been deprecated.");
      deprecated("10.7.0", "Please use highlight(code, options) instead.\nhttps://github.com/highlightjs/highlight.js/issues/2277");
      languageName = codeOrLanguageName;
      code = optionsOrCode;
    }

    // https://github.com/highlightjs/highlight.js/issues/3149
    if (ignoreIllegals === undefined) { ignoreIllegals = true; }

    // lamassu: no plugins, so no before:highlight/after:highlight; the
    // context object stays so the shape of `result.code` is upstream's.
    const context = {
      code,
      language: languageName
    };

    const result = _highlight(context.language, context.code, ignoreIllegals);

    result.code = context.code;

    return result;
  }

  /**
   * private highlight that's used internally and does not fire callbacks
   */
  function _highlight(languageName, codeToHighlight, ignoreIllegals, continuation) {
    const keywordHits = new Map(); // lamassu: for Object.create(null)

    /**
     * Return keyword data if a match is a keyword
     */
    function keywordData(mode, matchText) {
      return mode.keywords.get(matchText); // lamassu: the table is a Map
    }

    function processKeywords() {
      if (!top.keywords) {
        emitter.addText(modeBuffer);
        return;
      }

      let lastIndex = 0;
      top.keywordPatternRe.lastIndex = 0;
      let match = top.keywordPatternRe.exec(modeBuffer);
      let buf = "";

      while (match) {
        buf += modeBuffer.substring(lastIndex, match.index);
        const word = language.case_insensitive ? match[0].toLowerCase() : match[0];
        const data = keywordData(top, word);
        if (data) {
          const [kind, keywordRelevance] = data;
          emitter.addText(buf);
          buf = "";

          keywordHits.set(word, (keywordHits.get(word) || 0) + 1);
          if (keywordHits.get(word) <= MAX_KEYWORD_HITS) relevance += keywordRelevance;
          if (kind.startsWith("_")) {
            // _ implied for relevance only, do not highlight
            // by applying a class name
            buf += match[0];
          } else {
            const cssClass = language.classNameAliases[kind] || kind;
            emitKeyword(match[0], cssClass);
          }
        } else {
          buf += match[0];
        }
        lastIndex = top.keywordPatternRe.lastIndex;
        match = top.keywordPatternRe.exec(modeBuffer);
      }
      buf += modeBuffer.substring(lastIndex);
      emitter.addText(buf);
    }

    function processSubLanguage() {
      if (modeBuffer === "") return;
      let result = null;

      if (typeof top.subLanguage === 'string') {
        // lamassu: registered, whether or not its definition has run yet.
        if (!languages.has(top.subLanguage) && !pending.has(top.subLanguage)) {
          emitter.addText(modeBuffer);
          return;
        }
        result = _highlight(top.subLanguage, modeBuffer, true, continuations.get(top.subLanguage));
        continuations.set(top.subLanguage, result._top);
      } else {
        result = highlightAuto(modeBuffer, top.subLanguage.length ? top.subLanguage : null);
      }

      // Counting embedded language score towards the host language may be disabled
      // with zeroing the containing mode relevance. Use case in point is Markdown that
      // allows XML everywhere and makes every XML snippet to have a much larger Markdown
      // score.
      if (top.relevance > 0) {
        relevance += result.relevance;
      }
      emitter.__addSublanguage(result._emitter, result.language);
    }

    function processBuffer() {
      if (top.subLanguage != null) {
        processSubLanguage();
      } else {
        processKeywords();
      }
      modeBuffer = '';
    }

    function emitKeyword(keyword, scope) {
      if (keyword === "") return;

      emitter.startScope(scope);
      emitter.addText(keyword);
      emitter.endScope();
    }

    function emitMultiClass(scope, match) {
      let i = 1;
      const max = match.length - 1;
      while (i <= max) {
        if (!scope._emit[i]) { i++; continue; }
        const klass = language.classNameAliases[scope[i]] || scope[i];
        const text = match[i];
        if (klass) {
          emitKeyword(text, klass);
        } else {
          modeBuffer = text;
          processKeywords();
          modeBuffer = "";
        }
        i++;
      }
    }

    /**
     * @param mode - new mode to start
     */
    function startNewMode(mode, match) {
      if (mode.scope && typeof mode.scope === "string") {
        emitter.openNode(language.classNameAliases[mode.scope] || mode.scope);
      }
      if (mode.beginScope) {
        // beginScope just wraps the begin match itself in a scope
        if (mode.beginScope._wrap) {
          emitKeyword(modeBuffer, language.classNameAliases[mode.beginScope._wrap] || mode.beginScope._wrap);
          modeBuffer = "";
        } else if (mode.beginScope._multi) {
          // at this point modeBuffer should just be the match
          emitMultiClass(mode.beginScope, match);
          modeBuffer = "";
        }
      }

      top = frame(mode, top); // lamassu: see frame()
      return top;
    }

    /**
     * @param mode - the mode to potentially end
     * @param match - the latest match
     * @param matchPlusRemainder - match plus remainder of content
     * @returns the next mode, or if void continue on in current mode
     */
    function endOfMode(mode, match, matchPlusRemainder) {
      let matched = startsWith(mode.endRe, matchPlusRemainder);

      if (matched) {
        if (mode["on:end"]) {
          const resp = new Response(mode);
          mode["on:end"](match, resp);
          if (resp.isMatchIgnored) matched = false;
        }

        if (matched) {
          while (mode.endsParent && mode.parent) {
            mode = mode.parent;
          }
          return mode;
        }
      }
      // even if on:end fires an `ignore` it's still possible
      // that we might trigger the end node because of a parent mode
      if (mode.endsWithParent) {
        return endOfMode(mode.parent, match, matchPlusRemainder);
      }
    }

    /**
     * Handle matching but then ignoring a sequence of text
     */
    function doIgnore(lexeme) {
      if (top.matcher.regexIndex === 0) {
        // no more regexes to potentially match here, so we move the cursor forward one
        // space
        modeBuffer += lexeme[0];
        return 1;
      } else {
        // no need to move the cursor, we still have additional regexes to try and
        // match at this very spot
        resumeScanAtSamePosition = true;
        return 0;
      }
    }

    /**
     * Handle the start of a new potential mode match
     *
     * @returns how far to advance the parse cursor
     */
    function doBeginMatch(match) {
      const lexeme = match[0];
      const newMode = match.rule;

      const resp = new Response(newMode);
      // first internal before callbacks, then the public ones
      const beforeCallbacks = [newMode.__beforeBegin, newMode["on:begin"]];
      for (const cb of beforeCallbacks) {
        if (!cb) continue;
        cb(match, resp);
        if (resp.isMatchIgnored) return doIgnore(lexeme);
      }

      if (newMode.skip) {
        modeBuffer += lexeme;
      } else {
        if (newMode.excludeBegin) {
          modeBuffer += lexeme;
        }
        processBuffer();
        if (!newMode.returnBegin && !newMode.excludeBegin) {
          modeBuffer = lexeme;
        }
      }
      startNewMode(newMode, match);
      return newMode.returnBegin ? 0 : lexeme.length;
    }

    /**
     * Handle the potential end of mode
     */
    function doEndMatch(match) {
      const lexeme = match[0];
      const matchPlusRemainder = codeToHighlight.substring(match.index);

      const endMode = endOfMode(top, match, matchPlusRemainder);
      if (!endMode) { return NO_MATCH; }

      const origin = top;
      if (top.endScope && top.endScope._wrap) {
        processBuffer();
        emitKeyword(lexeme, top.endScope._wrap);
      } else if (top.endScope && top.endScope._multi) {
        processBuffer();
        emitMultiClass(top.endScope, match);
      } else if (origin.skip) {
        modeBuffer += lexeme;
      } else {
        if (!(origin.returnEnd || origin.excludeEnd)) {
          modeBuffer += lexeme;
        }
        processBuffer();
        if (origin.excludeEnd) {
          modeBuffer = lexeme;
        }
      }
      do {
        if (top.scope) {
          emitter.closeNode();
        }
        if (!top.skip && !top.subLanguage) {
          relevance += top.relevance;
        }
        top = top.parent;
      } while (top !== endMode.parent);
      if (endMode.starts) {
        startNewMode(endMode.starts, match);
      }
      return origin.returnEnd ? 0 : lexeme.length;
    }

    function processContinuations() {
      const list = [];
      for (let current = top; current !== language; current = current.parent) {
        if (current.scope) {
          list.unshift(current.scope);
        }
      }
      list.forEach(item => emitter.openNode(item));
    }

    let lastMatch = {};

    /**
     *  Process an individual match
     *
     * @param textBeforeMatch - text preceding the match (since the last match)
     * @param match - the match itself
     */
    function processLexeme(textBeforeMatch, match) {
      const lexeme = match && match[0];

      // add non-matched text to the current mode buffer
      modeBuffer += textBeforeMatch;

      if (lexeme == null) {
        processBuffer();
        return 0;
      }

      // we've found a 0 width match and we're stuck, so we need to advance
      // this happens when we have badly behaved rules that have optional matchers to the degree that
      // sometimes they can end up matching nothing at all
      // Ref: https://github.com/highlightjs/highlight.js/issues/2140
      if (lastMatch.type === "begin" && match.type === "end" && lastMatch.index === match.index && lexeme === "") {
        // spit the "skipped" character that our regex choked on back into the output sequence
        modeBuffer += codeToHighlight.slice(match.index, match.index + 1);
        if (!SAFE_MODE) {
          const err = new Error(`0 width match regex (${languageName})`);
          err.languageName = languageName;
          err.badRule = lastMatch.rule;
          throw err;
        }
        return 1;
      }
      lastMatch = match;

      if (match.type === "begin") {
        return doBeginMatch(match);
      } else if (match.type === "illegal" && !ignoreIllegals) {
        // illegal match, we do not continue processing
        const err = new Error('Illegal lexeme "' + lexeme + '" for mode "' + (top.scope || '<unnamed>') + '"');
        err.mode = top;
        throw err;
      } else if (match.type === "end") {
        const processed = doEndMatch(match);
        if (processed !== NO_MATCH) {
          return processed;
        }
      }

      // edge case for when illegal matches $ (end of line/text) which is technically
      // a 0 width match but not a begin/end match so it's not caught by the
      // first handler (when `ignoreIllegals` is true)
      if (match.type === "illegal" && lexeme === "") {
        if (match.index === codeToHighlight.length) ; else {
          // matched literal `\n` (with `$`) so we must manually add the newline
          // itself to the modeBuffer so it is not lost when we advance the cursor
          modeBuffer += "\n";
        }
        return 1;
      }

      // infinite loops are BAD, this is a last ditch catch all. if we have a
      // decent number of iterations yet our index (cursor position in our
      // parsing) still 3x behind our index then something is very wrong
      // so we bail
      if (iterations > 100000 && iterations > match.index * 3) {
        const err = new Error('potential infinite loop, way more iterations than matches');
        throw err;
      }

      /*
      Why might be find ourselves here?  An potential end match that was
      triggered but could not be completed.  IE, `doEndMatch` returned NO_MATCH.
      (this could be because a callback requests the match be ignored, etc)

      This causes no real harm other than stopping a few times too many.
      */

      modeBuffer += lexeme;
      return lexeme.length;
    }

    const language = getLanguage(languageName);
    if (!language) {
      error(LANGUAGE_NOT_FOUND.replace("{}", languageName));
      throw new Error('Unknown language: "' + languageName + '"');
    }

    const md = compileLanguage(language, regexCache);
    let result = '';
    let top = continuation || md;
    const continuations = new Map(); // keep continuations for sub-languages
    const emitter = new options.__emitter(options);
    processContinuations();
    let modeBuffer = '';
    let relevance = 0;
    let index = 0;
    let iterations = 0;
    let resumeScanAtSamePosition = false;

    try {
      if (!language.__emitTokens) {
        top.matcher.considerAll();

        for (;;) {
          iterations++;
          if (resumeScanAtSamePosition) {
            // only regexes not matched previously will now be
            // considered for a potential match
            resumeScanAtSamePosition = false;
          } else {
            top.matcher.considerAll();
          }
          top.matcher.lastIndex = index;

          const match = top.matcher.exec(codeToHighlight);

          if (!match) break;

          const beforeMatch = codeToHighlight.substring(index, match.index);
          const processedCount = processLexeme(beforeMatch, match);
          index = match.index + processedCount;
        }
        processLexeme(codeToHighlight.substring(index));
      } else {
        language.__emitTokens(codeToHighlight, emitter);
      }

      emitter.finalize();
      result = emitter.toHTML();

      return {
        language: languageName,
        value: result,
        relevance,
        illegal: false,
        _emitter: emitter,
        _top: top
      };
    } catch (err) {
      if (err.message && err.message.includes('Illegal')) {
        return {
          language: languageName,
          value: escape(codeToHighlight),
          illegal: true,
          relevance: 0,
          _illegalBy: {
            message: err.message,
            index,
            context: codeToHighlight.slice(index - 100, index + 100),
            mode: err.mode,
            resultSoFar: result
          },
          _emitter: emitter
        };
      } else if (SAFE_MODE) {
        return {
          language: languageName,
          value: escape(codeToHighlight),
          illegal: false,
          relevance: 0,
          errorRaised: err,
          _emitter: emitter,
          _top: top
        };
      } else {
        throw err;
      }
    }
  }

  /**
   * returns a valid highlight result, without actually doing any actual work,
   * auto highlight starts with this and it's possible for small snippets that
   * auto-detection may not find a better match
   */
  function justTextHighlightResult(code) {
    const result = {
      value: escape(code),
      illegal: false,
      relevance: 0,
      _top: PLAINTEXT_LANGUAGE,
      _emitter: new options.__emitter(options)
    };
    result._emitter.addText(code);
    return result;
  }

  /**
  Highlighting with language detection. Accepts a string with the code to
  highlight. Returns an object with the following properties:

  - language (detected language)
  - relevance (int)
  - value (an HTML string with highlighting markup)
  - secondBest (object with the same structure for second-best heuristically
    detected language, may be absent)
  */
  function highlightAuto(code, languageSubset) {
    languageSubset = languageSubset || options.languages || listLanguages();
    const plaintext = justTextHighlightResult(code);

    const results = languageSubset.filter(getLanguage).filter(autoDetection).map(name =>
      _highlight(name, code, false)
    );
    results.unshift(plaintext); // plaintext is always an option

    const sorted = results.sort((a, b) => {
      // sort base on relevance
      if (a.relevance !== b.relevance) return b.relevance - a.relevance;

      // always award the tie to the base language
      // ie if C++ and Arduino are tied, it's more likely to be C++
      if (a.language && b.language) {
        if (getLanguage(a.language).supersetOf === b.language) {
          return 1;
        } else if (getLanguage(b.language).supersetOf === a.language) {
          return -1;
        }
      }

      // otherwise say they are equal, which has the effect of sorting on
      // relevance while preserving the original ordering - which is how ties
      // have historically been settled, ie the language that comes first always
      // wins in the case of a tie
      return 0;
    });

    const [best, secondBest] = sorted;

    const result = best;
    result.secondBest = secondBest;

    return result;
  }

  /**
   * Updates highlight.js global options with the passed options
   */
  function configure(userOptions) {
    options = inherit(options, userOptions);
  }

  /**
   * Register a language grammar module
   */
  function registerLanguage(languageName, languageDefinition) {
    pending.set(languageName, languageDefinition);
    languages.delete(languageName);
    const declared = typeof ALIASES === 'object' && ALIASES !== null ? ALIASES[languageName] : undefined;
    if (declared) registerAliases(declared, { languageName });
  }

  /** Run a registered definition, once, the way upstream did at registration. */
  function defineLanguage(languageName) {
    const languageDefinition = pending.get(languageName);
    pending.delete(languageName);
    let lang = null;
    try {
      lang = languageDefinition(hljs);
    } catch (error$1) {
      error("Language definition for '{}' could not be registered.".replace("{}", languageName));
      // hard or soft error
      if (!SAFE_MODE) { throw error$1; } else { error(error$1); }
      // languages that have serious errors are replaced with essentially a
      // "plaintext" stand-in so that the code blocks will still get normal
      // css classes applied to them - and one bad language won't break the
      // entire highlighter
      lang = PLAINTEXT_LANGUAGE;
    }
    // give it a temporary name if it doesn't have one in the meta-data
    if (!lang.name) lang.name = languageName;
    lang.__key = languageName; // lamassu: for KEYWORD_SCOPES
    languages.set(languageName, lang);
    lang.rawDefinition = () => languageDefinition(hljs); // lamassu: for .bind

    if (lang.aliases) {
      registerAliases(lang.aliases, { languageName });
    }
  }

  /**
   * Remove a language grammar module
   */
  function unregisterLanguage(languageName) {
    languages.delete(languageName);
    pending.delete(languageName);
    for (const alias of aliases.keys()) {
      if (aliases.get(alias) === languageName) {
        aliases.delete(alias);
      }
    }
  }

  /**
   * @returns List of language internal names
   */
  function listLanguages() {
    const names = [];
    languages.forEach((_lang, name) => { names.push(name); });
    pending.forEach((_def, name) => { if (!languages.has(name)) names.push(name); });
    return names;
  }

  /**
   * @param name - name of the language to retrieve
   */
  function getLanguage(name) {
    name = (name || '').toLowerCase();
    const resolved = languages.has(name) || pending.has(name) ? name : aliases.get(name);
    if (resolved !== undefined && pending.has(resolved)) defineLanguage(resolved);
    return languages.get(resolved);
  }

  function registerAliases(aliasList, { languageName }) {
    if (typeof aliasList === 'string') {
      aliasList = [aliasList];
    }
    aliasList.forEach(alias => { aliases.set(alias.toLowerCase(), languageName); });
  }

  /**
   * Determines if a given language has auto-detection enabled
   */
  function autoDetection(name) {
    const lang = getLanguage(name);
    return lang && !lang.disableAutodetect;
  }

  /* Interface definition */
  Object.assign(hljs, {
    highlight,
    highlightAuto,
    configure,
    registerLanguage,
    unregisterLanguage,
    listLanguages,
    getLanguage,
    registerAliases,
    autoDetection,
    inherit
  });

  hljs.debugMode = function () { SAFE_MODE = false; };
  hljs.safeMode = function () { SAFE_MODE = true; };
  hljs.versionString = version;

  hljs.regex = {
    concat: concat,
    lookahead: lookahead,
    either: either,
    optional: optional,
    anyNumberOfTimes: anyNumberOfTimes
  };

  Object.keys(MODES).forEach((key) => {
    if (typeof MODES[key] === "object") {
      deepFreeze(MODES[key]);
    }
  });

  // merge all the modes/regexes into our main object
  Object.assign(hljs, MODES);

  return hljs;
};

// lamassu: no module system. build.mjs wraps this file in a function that
// returns what upstream exported — an instance, with newInstance() on it.
const highlight = HLJS({});
highlight.newInstance = () => HLJS({});
