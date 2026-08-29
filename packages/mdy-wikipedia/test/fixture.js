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
