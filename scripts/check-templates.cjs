#!/usr/bin/env node
/**
 * Compile every authored SFC template and report errors.
 *
 * `pnpm typecheck` does NOT check Vue templates — `typescript.typeCheck` is false in
 * nuxt.config, which is why the house standard insists every UI change is verified in a real browser.
 * This closes the cheapest part of that gap: an unbalanced tag or a malformed directive is a
 * compile error the type checker sails past and the browser only shows as a blank page.
 */
const fs = require('node:fs')
const path = require('node:path')

const SFC = path.join(
  __dirname,
  '../node_modules/.pnpm/@vue+compiler-sfc@3.5.41/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs',
)
const { parse, compileTemplate } = require(SFC)

const ROOT = path.join(__dirname, '../app/app')
const files = []
;(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.vue')) files.push(full)
  }
})(ROOT)

let bad = 0
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const rel = path.relative(path.join(__dirname, '..'), file)
  const { descriptor, errors } = parse(src, { filename: file })
  if (errors.length) {
    bad++
    console.log(`PARSE  ${rel}`)
    errors.forEach((e) => console.log(`   - ${e.message}`))
    continue
  }
  if (!descriptor.template) continue
  const result = compileTemplate({ source: descriptor.template.content, filename: file, id: 'x' })
  if (result.errors.length) {
    bad++
    console.log(`TEMPLATE  ${rel}`)
    result.errors.forEach((e) => console.log(`   - ${typeof e === 'string' ? e : e.message}`))
  }
}

console.log(bad === 0 ? `✓ ${files.length} templates compile` : `✗ ${bad} file(s) with errors`)
process.exit(bad === 0 ? 0 : 1)
