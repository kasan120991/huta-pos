import { describe, expect, it } from 'vitest'

import { slugify, uniqueSlug } from '../src/slug.js'

describe('slugify', () => {
  it.each([
    ['Naysa CBD Drops', 'naysa-cbd-drops'],
    ['Skin Care', 'skin-care'],
    ['Rolling Trays', 'rolling-trays'],
    ['  Trimmed  ', 'trimmed'],
    ['THC-P', 'thc-p'],
    ['Delta-8', 'delta-8'],
  ])('slugifies %s to %s', (input, expected) => {
    expect(slugify(input)).toBe(expected)
  })

  // Every case below is a real string from the legacy catalog. They are the reason this
  // function normalises rather than just lowercasing.
  it('folds the two apostrophe spellings of the same product together', () => {
    expect(slugify('Lost 8’s Party Pack')).toBe(slugify("Lost 8's Party Pack"))
    expect(slugify("Lost 8's Party Pack")).toBe('lost-8s-party-pack')
  })

  it('folds a hyphen against a space in the same product name', () => {
    expect(slugify('The Hemp Doctor Delta-8 Cartridge')).toBe(
      slugify('The Hemp Doctor Delta 8 Cartridge'),
    )
  })

  it('handles en dashes', () => {
    expect(slugify('Lost8’s X Toast Gummies – Delta 8, HHC & HHC-P')).toBe(
      'lost8s-x-toast-gummies-delta-8-hhc-hhc-p',
    )
  })

  it('folds diacritics to base letters', () => {
    expect(slugify("Dr. Greenthumb's X Stündenglass Gravity Infuser")).toBe(
      'dr-greenthumbs-x-stundenglass-gravity-infuser',
    )
  })

  it('drops apostrophes rather than splitting on them', () => {
    // "lost-8-s" would be wrong — it reads as three tokens.
    expect(slugify("Lost8's")).toBe('lost8s')
  })

  it.each([
    ['Huta HHC + THC-P + Delta-9 Cartridge', 'huta-hhc-thc-p-delta-9-cartridge'],
    ['Binoid Delta-8/10 Cartridge', 'binoid-delta-8-10-cartridge'],
    ['Goliath x Extrax - Starter Kit', 'goliath-x-extrax-starter-kit'],
    ['Large Tray w/ Lid', 'large-tray-w-lid'],
    ['Just CBD+THC Sour Gummies', 'just-cbd-thc-sour-gummies'],
  ])('collapses punctuation runs: %s', (input, expected) => {
    expect(slugify(input)).toBe(expected)
  })

  it('never produces leading, trailing or doubled hyphens', () => {
    for (const input of ['---x---', '  &&  x  &&  ', '!!!', 'a---b']) {
      const slug = slugify(input)
      expect(slug).not.toMatch(/^-|-$|--/)
    }
  })

  it('returns an empty string for input with no alphanumerics', () => {
    expect(slugify('!!!')).toBe('')
    expect(slugify('')).toBe('')
  })
})

describe('uniqueSlug', () => {
  it('returns the base when free, then suffixes', () => {
    const taken = new Set<string>()
    expect(uniqueSlug('glass-bong', taken)).toBe('glass-bong')
    expect(uniqueSlug('glass-bong', taken)).toBe('glass-bong-2')
    expect(uniqueSlug('glass-bong', taken)).toBe('glass-bong-3')
  })

  it('skips suffixes already taken', () => {
    const taken = new Set(['x', 'x-2'])
    expect(uniqueSlug('x', taken)).toBe('x-3')
  })
})
