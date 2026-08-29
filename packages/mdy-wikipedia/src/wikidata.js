/**
 * A Wikidata entity as a record.
 *
 * The claims are typed where an infobox is text — Babylon's inception is
 * `-1894-00-00T00:00:00Z` with `precision: 9`, against the infobox's
 * `c. 2200 BC` — which is the reason to want them. What makes them awkward is
 * that everything is an opaque id: `P31` is `Q133442`, and neither says
 * anything until both are looked up. `fetch.js` does that lookup; this turns
 * the result into `instance-of: city-state`.
 *
 * Two decisions worth naming.
 *
 * **External identifiers are kept apart.** 69 of Babylon's 131 statements are
 * `external-id` — GeoNames, Freebase, Quora, a dozen library catalogues — and
 * mixed in with the rest they bury the eleven claims anybody came for. They are
 * exactly what you want when you are reconciling against another database and
 * exactly what you do not want when you are reading, so they go under
 * `identifiers`. The datatype says which is which; no list of properties has to
 * be maintained.
 *
 * **Deprecated statements are dropped and preferred ones win.** Wikidata's rank
 * is how it records that a claim is superseded or disputed, and an importer
 * that ignores rank is an importer that quietly resurrects the wrong answer.
 */

const bce = (year) => Math.abs(year) + ' BC'
const ordinal = (value) => {
  const rest = value % 100
  const suffix =
    rest > 10 && rest < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][value % 10] ?? 'th'

  return value + suffix
}

/**
 * @param {object} entity
 *   The entity as `Special:EntityData` gives it.
 * @param {Record<string, string>} labels
 *   Labels for every property and item it names.
 * @param {{lang?: string}} [options]
 * @returns {object}
 */
export function wikidataRecord(entity, labels, options = {}) {
  const lang = options.lang ?? 'en'
  /** @type {Record<string, unknown>} */
  const claims = {}
  /** @type {Record<string, unknown>} */
  const identifiers = {}

  for (const [property, statements] of Object.entries(entity.claims ?? {})) {
    const name = slug(labels[property] ?? property)
    const best = rank(statements)
    const values = best
      .map((statement) => render(statement.mainsnak, labels))
      .filter((value) => value !== undefined)

    if (!values.length) continue

    const into = best[0].mainsnak?.datatype === 'external-id' ? identifiers : claims
    const value = values.length === 1 ? values[0] : values

    // Two properties can slug to the same name — `P625` and a duplicate under
    // another label — and the first one written is the one Wikidata lists
    // first, which is the one it considers primary.
    if (into[name] === undefined) into[name] = value
  }

  /** @type {Record<string, unknown>} */
  const out = {id: entity.id}
  const label = entity.labels?.[lang]?.value ?? entity.labels?.en?.value
  const description =
    entity.descriptions?.[lang]?.value ?? entity.descriptions?.en?.value

  if (label) out.label = label
  if (description) out.description = description
  if (Object.keys(claims).length) out.claims = claims
  if (Object.keys(identifiers).length) out.identifiers = identifiers

  return out
}

/**
 * The statements that count.
 *
 * Deprecated ones are wrong on purpose — Wikidata keeps them to record that
 * somebody published them — and a preferred one is there to say "this, not the
 * others". Ignoring rank means writing down the superseded answer beside the
 * current one with nothing to tell them apart.
 *
 * @param {Array<object>} statements
 * @returns {Array<object>}
 */
function rank(statements) {
  const live = statements.filter((statement) => statement.rank !== 'deprecated')
  const preferred = live.filter((statement) => statement.rank === 'preferred')

  return preferred.length ? preferred : live
}

/**
 * One value, in the spelling its datatype deserves.
 *
 * @param {object} snak
 * @param {Record<string, string>} labels
 * @returns {unknown}
 */
function render(snak, labels) {
  // `novalue` and `somevalue` are Wikidata saying "there is none" and "there is
  // one and nobody knows it". Neither is a value to write down.
  if (snak?.snaktype !== 'value') return

  const {value} = snak.datavalue ?? {}

  switch (snak.datavalue?.type) {
    case 'wikibase-entityid':
      return labels[value.id] ?? value.id
    case 'time':
      return time(value)
    case 'globecoordinate':
      return {lat: value.latitude, lon: value.longitude}
    case 'quantity':
      return quantity(value, labels)
    case 'monolingualtext':
      return value.text
    case 'string':
      return snak.datatype === 'commonsMedia'
        ? 'https://commons.wikimedia.org/wiki/Special:FilePath/' +
            encodeURIComponent(String(value).replaceAll(' ', '_'))
        : value
    default:
      return typeof value === 'string' ? value : undefined
  }
}

/**
 * A time, written to the precision Wikidata claims for it.
 *
 * The precision is the whole point. `-1894-00-00T00:00:00Z` is not the tenth of
 * never: it is the year 1894 BC, and the zeroes are Wikidata saying it does not
 * know the month. Writing it out as a date would invent two facts.
 *
 * @param {{time: string, precision: number}} value
 * @returns {string | undefined}
 */
function time(value) {
  const match = /^([+-])(\d+)-(\d\d)-(\d\d)/.exec(String(value.time ?? ''))

  if (!match) return

  const before = match[1] === '-'
  const year = Number(match[2])
  const [, , , month, day] = match

  if (!year) return

  if (value.precision >= 11) {
    return before
      ? bce(year) + ' (' + month + '-' + day + ')'
      : String(year).padStart(4, '0') + '-' + month + '-' + day
  }

  if (value.precision === 10) {
    return before ? bce(year) + ' (' + month + ')' : String(year).padStart(4, '0') + '-' + month
  }

  if (value.precision === 9) return before ? bce(year) : String(year)
  if (value.precision === 8) return (before ? bce(year) : year) + 's'
  if (value.precision === 7) {
    return ordinal(Math.ceil(year / 100)) + ' century' + (before ? ' BC' : '')
  }
  if (value.precision <= 6) {
    return ordinal(Math.ceil(year / 1000)) + ' millennium' + (before ? ' BC' : '')
  }
}

/**
 * @param {{amount: string, unit: string}} value
 * @param {Record<string, string>} labels
 * @returns {string}
 */
function quantity(value, labels) {
  const amount = String(value.amount ?? '').replace(/^\+/, '')
  const unit = String(value.unit ?? '')
  const name = unit.includes('/Q') ? labels[unit.slice(unit.lastIndexOf('/') + 1)] : undefined

  return name ? amount + ' ' + name : amount
}

/**
 * @param {string} value
 * @returns {string}
 */
function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}
