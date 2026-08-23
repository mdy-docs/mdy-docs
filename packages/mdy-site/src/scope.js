import {defaultMarkers} from 'mdy-docs/parse'

/**
 * Values the sample document interpolates, to show what a host can hand a
 * template. Nothing here is special to MDY: it is a plain object, and its keys
 * arrive in the document as variables.
 */
export const scope = {
  markers: defaultMarkers,
  rules: [
    {number: 1, name: 'Headings', added: 'first'},
    {number: 2, name: 'Thematic breaks', added: 'later'},
    {number: 3, name: 'Paragraphs', added: 'first'},
    {number: 4, name: 'Code fences', added: 'last'},
    {number: 5, name: 'Elements and indentation', added: 'later'},
    {number: 6, name: 'Lists', added: 'later'},
    {number: 7, name: 'Tables', added: 'later'},
    {number: 8, name: 'Inline markers', added: 'first'},
    {number: 9, name: 'Links', added: 'later'},
    {number: 10, name: 'Emoji', added: 'later'},
    {number: 11, name: 'Documents and front matter', added: 'last'},
    {number: 12, name: 'Script', added: 'last'},
    {number: 13, name: 'Comments', added: 'last'}
  ]
}
