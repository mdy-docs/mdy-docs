#!/usr/bin/env node
import {parseArgs} from 'node:util'
import {writeFile} from 'node:fs/promises'
import {wikipediaToMdy} from '../src/index.js'

const usage = `mdy-wikipedia — import a Wikipedia page as an mdy document.

Usage:
  mdy-wikipedia <title | lang:title | url> [options]

  mdy-wikipedia Babylon > babylon.mdy
  mdy-wikipedia https://en.wikipedia.org/wiki/Babylon --out babylon.mdy
  mdy-wikipedia fr:Babylone --links wiki --out docs/babylone.mdy

Options:
  --out <path>          write a file (default: stdout)
  --lang <code>         wiki language (default: en, or the prefix/URL's)
  --links <mode>        how internal links are written (default: url)
                          url   https://en.wikipedia.org/wiki/Babylonia
                          path  /wiki/Babylonia — for a site whose pages
                                these are; mdy lower cases a link to a page
                                of your own, which a Wikipedia path may not
                                survive
                          wiki  [[ Babylonia ]], into a vault of your own
  --sections <list>     only these sections, by heading or id; "lead" is the
                        part above the first heading
  --keep-sections       keep See also / References / External links as prose
  --refs <mode>         what becomes of the citations (default: footnotes)
                          footnotes  a real mdy footnote where each one was
                          data       a references list in the front matter
                          drop       neither
  --no-infobox          do not read the infobox into the front matter
  --no-images           do not list the images in the front matter
  --wrap <columns>      wrap paragraphs (default: 78; 0 for one line each)
  --no-title            do not write the page title as a heading
  --cache <dir>         where fetched pages are kept
                        (default: ~/.cache/mdy-wikipedia)
  --no-cache            do not read or write the cache
  --refresh             fetch even when the page is cached
  --contact <url|mail>  added to the User-Agent, as Wikimedia asks
  --quiet               do not report what was left out
  --help                this

Wikipedia's text is CC BY-SA 4.0. Every document written carries its source,
revision and attribution in the front matter; keep them if you publish it.
`

const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    out: {type: 'string'},
    lang: {type: 'string'},
    links: {type: 'string'},
    sections: {type: 'string'},
    'keep-sections': {type: 'boolean'},
    refs: {type: 'string'},
    wrap: {type: 'string'},
    cache: {type: 'string'},
    refresh: {type: 'boolean'},
    // `parseArgs` has no notion of a negated flag, so the four `--no-…` ones
    // are their own options rather than defaults to be turned off.
    'no-title': {type: 'boolean'},
    'no-infobox': {type: 'boolean'},
    'no-images': {type: 'boolean'},
    'no-cache': {type: 'boolean'},
    contact: {type: 'string'},
    quiet: {type: 'boolean'},
    help: {type: 'boolean', short: 'h'}
  }
})

if (values.help || !positionals.length) {
  process.stdout.write(usage)
  process.exit(values.help ? 0 : 1)
}

if (values.links && !['path', 'url', 'wiki'].includes(values.links)) {
  process.stderr.write('--links must be one of: path, url, wiki\n')
  process.exit(1)
}

if (values.refs && !['footnotes', 'data', 'drop'].includes(values.refs)) {
  process.stderr.write('--refs must be one of: footnotes, data, drop\n')
  process.exit(1)
}

// Messages are the point of the exercise, not an afterthought: they say what
// the page held that an mdy document cannot, which is how the cleaner is
// judged. They go to stderr so the document can still be piped.
const messages = []
const file = {message: (reason) => messages.push(String(reason))}

try {
  const {source, counts} = await wikipediaToMdy(positionals[0], {
    lang: values.lang,
    links: values.links ?? 'url',
    sections: values.sections?.split(',').map((name) => name.trim()).filter(Boolean),
    keepSections: values['keep-sections'],
    refs: values.refs ?? 'footnotes',
    infobox: !values['no-infobox'],
    images: !values['no-images'],
    wrap: values.wrap === undefined ? undefined : Number(values.wrap),
    title: !values['no-title'],
    cache: values['no-cache'] ? false : values.cache,
    refresh: values.refresh,
    contact: values.contact,
    file
  })

  if (values.out) await writeFile(values.out, source)
  else process.stdout.write(source)

  if (!values.quiet) report(counts, messages, values.out)
} catch (error) {
  process.stderr.write('mdy-wikipedia: ' + error.message + '\n')
  process.exit(1)
}

/**
 * @param {Record<string, number>} counts
 * @param {Array<string>} messages
 * @param {string | undefined} out
 */
function report(counts, messages, out) {
  const tally = new Map()

  for (const message of messages) tally.set(message, (tally.get(message) ?? 0) + 1)

  const removed = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => name + ' ' + count)
    .join(', ')

  if (out) process.stderr.write('wrote ' + out + '\n')
  if (removed) process.stderr.write('removed: ' + removed + '\n')

  for (const [message, count] of [...tally].sort((a, b) => b[1] - a[1])) {
    process.stderr.write('  ' + count + '× ' + message + '\n')
  }
}
