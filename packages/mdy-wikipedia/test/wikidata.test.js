import assert from 'node:assert/strict'
import test from 'node:test'
import {wikidataRecord} from '../src/wikidata.js'
import {babylonEntity, babylonLabels} from './fixture.js'

const record = wikidataRecord(babylonEntity, babylonLabels)

test('the entity says what it is', () => {
  assert.equal(record.id, 'Q5684')
  assert.equal(record.label, 'Babylon')
  assert.match(record.description, /capital city of Babylonia/)
})

test('claims are readable, because both halves are looked up', () => {
  // `P31` → `Q133442` says nothing until both are resolved.
  assert.deepEqual(record.claims['instance-of'], [
    'city-state',
    'ancient city',
    'archaeological site'
  ])
  assert.equal(
    record.claims['located-in-the-administrative-territorial-entity'],
    'Babylon Governorate'
  )
})

test('external identifiers are kept apart from the claims', () => {
  // 66 of Babylon's statements are external ids. Mixed in, they bury the two
  // dozen claims anybody came for; the datatype says which is which, so no
  // list of properties has to be kept up to date.
  assert.equal(record.identifiers['geonames-id'], '98228')
  assert.equal(record.identifiers['freebase-id'], '/m/01cyh')
  assert.ok(Object.keys(record.identifiers).length > 50)
  assert.ok(Object.keys(record.claims).length < 30)

  for (const name of Object.keys(record.claims)) {
    assert.ok(!name.endsWith('-id'), name + ' looks like an identifier')
  }
})

test('a deprecated statement is not the answer', () => {
  // Babylon's inception has two claims: a deprecated one to the year 1894 BC,
  // and a live one to the 3rd millennium BC. Ignoring rank writes down the
  // superseded answer with nothing to say it is superseded.
  assert.equal(record.claims.inception, '3rd millennium BC')
})

test('a time is written to the precision it claims', () => {
  const at = (time, precision) =>
    wikidataRecord(
      {
        id: 'Q1',
        claims: {
          P1: [
            {
              rank: 'normal',
              mainsnak: {
                snaktype: 'value',
                datatype: 'time',
                datavalue: {type: 'time', value: {time, precision}}
              }
            }
          ]
        }
      },
      {P1: 'when'}
    ).claims.when

  assert.equal(at('+1815-12-10T00:00:00Z', 11), '1815-12-10')
  assert.equal(at('+1815-12-00T00:00:00Z', 10), '1815-12')
  assert.equal(at('+1815-00-00T00:00:00Z', 9), '1815')
  assert.equal(at('+1810-00-00T00:00:00Z', 8), '1810s')
  assert.equal(at('+1815-00-00T00:00:00Z', 7), '19th century')
  // The zeroes are Wikidata saying it does not know the month, so writing this
  // out as a date would invent two facts.
  assert.equal(at('-1894-00-00T00:00:00Z', 9), '1894 BC')
  assert.equal(at('-2200-00-00T00:00:00Z', 6), '3rd millennium BC')
})

test('the other datatypes come out as themselves', () => {
  assert.deepEqual(record.claims['coordinate-location'][0], {
    lat: 32.5425,
    lon: 44.42111111111111
  })
  assert.match(record.claims.image, /^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//)
  assert.equal(record.claims['commons-category'], 'Babylon')
})

test('a value nobody knows is not written down as one', () => {
  // `somevalue` is Wikidata saying there is one and nobody knows it.
  const record = wikidataRecord(
    {
      id: 'Q1',
      claims: {
        P1: [{rank: 'normal', mainsnak: {snaktype: 'somevalue', datatype: 'wikibase-item'}}]
      }
    },
    {P1: 'father'}
  )

  assert.equal(record.claims, undefined)
})

test('without labels it degrades to ids rather than to nothing', () => {
  const bare = wikidataRecord(babylonEntity, {})

  assert.deepEqual(bare.claims.p31, ['Q133442', 'Q15661340', 'Q839954'])
})

test('a label in any script keys as itself', () => {
  const record = wikidataRecord(
    {
      id: 'Q1',
      claims: {
        P1: [
          {
            rank: 'normal',
            mainsnak: {
              snaktype: 'value',
              datatype: 'external-id',
              datavalue: {type: 'string', value: 'babylone'}
            }
          }
        ]
      }
    },
    {P1: 'Encyclopædia Universalis ID'}
  )

  assert.equal(record.identifiers['encyclopædia-universalis-id'], 'babylone')
})
