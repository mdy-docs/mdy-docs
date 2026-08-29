#!/usr/bin/env node
import {parseArgs} from 'node:util'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {documentPath, importVault, wikipediaToMdy} from '../src/index.js'

const usage = `mdy-wikipedia — import a Wikipedia page as an mdy document.

Usage:
  mdy-wikipedia <title | lang:title | url>... [options]

  mdy-wikipedia Babylon > babylon.mdy
  mdy-wikipedia https://en.wikipedia.org/wiki/Babylon --out babylon.mdy
  mdy-wikipedia fr:Babylone --links wiki --out docs/babylone.mdy

  mdy-wikipedia Babylon Nineveh Ur --out-dir vault
  mdy-wikipedia --category "Ancient Assyrian cities" --out-dir vault --links wiki
  mdy-wikipedia Babylon --follow 1 --max 25 --out-dir vault --links wiki

More than one page makes a vault: a directory of documents whose infobox
fields are queryable together, which is what --links wiki cross-links.

Options:
  --out <path>          write a file (default: stdout); one page only
  --out-dir <dir>       write one document per page, named as --links wiki
                        links to it, so a vault cross-links itself
  --category <name>     import every article in a category
  --from <file>         import the titles in a file, one per line ("-" reads
                        standard input)
  --follow <depth>      also import the pages a document links to, to this
                        depth (default: 0, none)
  --max <n>             hard cap on documents written (default: 100). Following
                        links is how importing one page becomes importing a
                        thousand; Babylon alone links to 292
  --delay <ms>          gap between network requests (default: 100)
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
  --wikidata            resolve the page's Wikidata claims into the front
                        matter (two more requests: the entity, then the
                        labels for everything it names)
  --categories          list the page's categories
  --lang-links          list the page in every other language it exists in
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
    'out-dir': {type: 'string'},
    category: {type: 'string'},
    from: {type: 'string'},
    follow: {type: 'string'},
    max: {type: 'string'},
    delay: {type: 'string'},
    lang: {type: 'string'},
    links: {type: 'string'},
    sections: {type: 'string'},
    'keep-sections': {type: 'boolean'},
    refs: {type: 'string'},
    wikidata: {type: 'boolean'},
    categories: {type: 'boolean'},
    'lang-links': {type: 'boolean'},
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

if (values.help || (!positionals.length && !values.category && !values.from)) {
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
const settings = {
  lang: values.lang,
  links: values.links ?? 'url',
  sections: values.sections?.split(',').map((name) => name.trim()).filter(Boolean),
  keepSections: values['keep-sections'],
  refs: values.refs ?? 'footnotes',
  wikidata: values.wikidata,
  categories: values.categories,
  langLinks: values['lang-links'],
  infobox: !values['no-infobox'],
  images: !values['no-images'],
  wrap: values.wrap === undefined ? undefined : Number(values.wrap),
  title: !values['no-title'],
  cache: values['no-cache'] ? false : values.cache,
  refresh: values.refresh,
  contact: values.contact,
  delay: values.delay === undefined ? undefined : Number(values.delay),
  follow: values.follow === undefined ? 0 : Number(values.follow),
  max: values.max === undefined ? undefined : Number(values.max),
  file: {message: (reason) => messages.push(String(reason))}
}

const seeds = [...positionals]

if (values.from) {
  const list = values.from === '-'
    ? await readStdin()
    : await readFile(values.from, 'utf8')

  for (const line of list.split('\n')) {
    const title = line.trim()

    if (title && !title.startsWith('#')) seeds.push(title)
  }
}

// One page or many. The difference is not the count of arguments — following
// links turns one seed into a vault — so it is whether an output directory was
// named at all.
const many = Boolean(values['out-dir'])

if (!many && (values.category || settings.follow > 0 || seeds.length > 1)) {
  process.stderr.write('mdy-wikipedia: importing more than one page needs --out-dir\n')
  process.exit(1)
}

try {
  if (many) await importMany(seeds)
  else await importOne(seeds[0])
} catch (error) {
  process.stderr.write('mdy-wikipedia: ' + error.message + '\n')
  process.exit(1)
}

/**
 * @param {string} seed
 */
async function importOne(seed) {
  const {source, counts} = await wikipediaToMdy(seed, settings)

  if (values.out) await writeFile(values.out, source)
  else process.stdout.write(source)

  if (!values.quiet) report(counts, messages, values.out)
}

/**
 * @param {Array<string>} seeds
 */
async function importMany(seeds) {
  const out = values['out-dir']
  const totals = {}
  let written = 0
  let failed = 0

  for await (const page of importVault(seeds, {
    ...settings,
    category: values.category,
    onProgress: (event) => {
      if (event.kind === 'capped' && !values.quiet) {
        process.stderr.write(
          'stopped at --max ' + event.reached + '; ' + event.left + ' more were queued\n'
        )
      }
    }
  })) {
    // Each page's messages are its own: which page could not say what is the
    // only useful form of that, and the run's total says nothing.
    messages.length = 0

    if (page.error) {
      failed += 1
      process.stderr.write('  ! ' + page.target.title + ': ' + page.error.message + '\n')
      continue
    }

    const path = join(out, page.path)

    await mkdir(dirname(path), {recursive: true})
    await writeFile(path, page.source)
    written += 1

    for (const [name, count] of Object.entries(page.counts)) {
      totals[name] = (totals[name] ?? 0) + count
    }

    if (!values.quiet) {
      const note = page.messages.length ? '  (' + page.messages.length + ' unwritable)' : ''

      process.stderr.write('  ' + page.path + note + '\n')
    }
  }

  if (values.quiet) return

  process.stderr.write(
    'wrote ' + written + ' document' + (written === 1 ? '' : 's') + ' to ' + out +
      (failed ? ', ' + failed + ' failed' : '') + '\n'
  )

  const removed = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => name + ' ' + count)
    .join(', ')

  if (removed) process.stderr.write('removed: ' + removed + '\n')
}

/**
 * @returns {Promise<string>}
 */
async function readStdin() {
  const chunks = []

  for await (const chunk of process.stdin) chunks.push(chunk)

  return Buffer.concat(chunks).toString('utf8')
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
