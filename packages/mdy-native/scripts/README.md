# scripts

Generators. Each reads a source of truth in mdy-docs' JavaScript and emits a
C header that is **committed**, so the build needs neither node nor
node_modules — and `make check-generated` re-runs all five and diffs, so a
header edited by hand goes red.

    generate-props.mjs    -> src/parse/props_table.h
        node_modules/property-information
    generate-schema.mjs   -> src/parse/schema_table.h
        src/parse/sanitize.js, for its `defaultSchema`
    generate-emoji.mjs    -> src/parse/emoji_table.h
        node_modules/emoticon and node_modules/gemoji
    generate-alerts.mjs   -> src/parse/alert_table.h
        node_modules/remark-github-blockquote-alert, for `getAlertIcon`
    toolkit.mjs           -> src/toolkit.h
        src/mdy.js

The four `generate-*` take the mdy-docs root as their one argument;
`toolkit.mjs` finds `src/mdy.js` relative to itself and takes none. All five
write to stdout.

**Why generated rather than transcribed.** Every one of these tables was
hand-written first and every one was wrong, in ways a reading could not catch:
the property table was twenty entries and wrong about `SRC`, `FOO` and
`DATA-x-Y` where the generated one is 426; the sanitize schema was missing
`time`'s `datetime` and the whole `strip` list, so elements that should be
dropped *with their content* were unwrapped instead. These are data, not
behaviour, and data copied by hand drifts the first time the package upstream
changes — silently, because nothing compares them.

## What is not here

Test harnesses live in `test/`, beside the checks that run them:
`compare-site.mjs` (`make check-sites`) with the five other `compare-*.mjs`,
`alloc-sweep.mjs` (`make check-alloc`) and `build-corpus.mjs` (`make corpus`).
They produce nothing the build consumes, which is the line: a script is here
if its output is committed source.
