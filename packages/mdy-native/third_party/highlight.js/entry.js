/*
 * What the engine calls. build.mjs puts this last in the bundle, after the
 * core, the emitter and the grammars, so `__lowlight` and `__grammars` are
 * in scope.
 *
 * `highlightCode` is mdy-docs' own function of that name
 * (src/parse/highlight.js), kept to the letter: a language nothing knows is
 * not an error, the class still says what it was meant to be and the code
 * still reads; and a grammar that throws leaves the text as it was. The
 * children it returns are what mdy-docs puts inside the <code> element, so
 * a tree built here and one built there differ in nothing.
 *
 * One throw is not the grammar's: the VM running out of memory. That is
 * rethrown, here and in the core's own catches, so the engine can end the
 * run rather than write a page with a fence left plain for a reason nobody
 * was told.
 */

/** lamassu's out-of-memory, whatever wrapped it. */
function outOfMemory(error) {
  const text = error && error.message ? error.message : String(error);
  return text.indexOf('out of memory') !== -1;
}

const lowlight = __lowlight(__grammars);

/**
 * Colour a block of code, or leave it as the text it is.
 *
 * @param {string} value
 * @param {string} language
 * @returns {{children: Array<object>, highlighted: boolean}}
 */
function highlightCode(value, language) {
  if (!language || !lowlight.registered(language)) {
    return { children: [{ type: 'text', value }], highlighted: false };
  }
  try {
    return { children: lowlight.highlight(language, value).children, highlighted: true };
  } catch (error) {
    if (outOfMemory(error)) throw error;
    return { children: [{ type: 'text', value }], highlighted: false };
  }
}

/** Is there a grammar for this name or alias? */
function highlightRegistered(language) {
  return Boolean(language) && lowlight.registered(language);
}
