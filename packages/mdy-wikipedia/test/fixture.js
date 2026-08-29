import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {gunzipSync} from 'node:zlib'

// Babylon's Parsoid HTML is half a megabyte, and it is machine output nobody
// will read in a diff, so it is kept gzipped. The summary beside it is small
// and stays readable.
const here = new URL('./fixtures/', import.meta.url)

export const babylonHtml = gunzipSync(
  readFileSync(fileURLToPath(new URL('babylon.html.gz', here)))
).toString('utf8')

export const babylonSummary = JSON.parse(
  readFileSync(fileURLToPath(new URL('babylon.summary.json', here)), 'utf8')
)

export const babylonTarget = {lang: 'en', title: 'Babylon'}

/** The Wikidata entity, trimmed to what the record builder reads. */
export const babylonEntity = JSON.parse(
  readFileSync(fileURLToPath(new URL('babylon.wikidata.json', here)), 'utf8')
).entities.Q5684

/** Labels for every property and item the entity names. */
export const babylonLabels = Object.fromEntries(
  Object.entries(
    JSON.parse(
      readFileSync(fileURLToPath(new URL('babylon.wikidata-labels.json', here)), 'utf8')
    ).entities
  )
    .map(([id, found]) => [id, found?.labels?.en?.value])
    .filter(([, label]) => label)
)

/** The Action API's categories and langlinks for the page. */
export const babylonIndexes = JSON.parse(
  readFileSync(fileURLToPath(new URL('babylon.indexes.json', here)), 'utf8')
).query.pages[0]
