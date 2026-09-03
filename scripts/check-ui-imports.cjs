#!/usr/bin/env node
/**
 * Every vendored `ui/` component used in a template must be imported in that file's script.
 *
 * Nuxt auto-imports `components/`, but NOT `components/ui/` — those are explicit imports. A
 * missing one is only a console WARNING ("Failed to resolve component"), so the element
 * renders as unknown markup: unstyled, inert, and invisible to `pnpm typecheck` AND to the
 * template compiler. The house notes record the same trap for path-prefixed component names.
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../app/app')
const UI = path.join(ROOT, 'components/ui')

// Every exported component name, mapped to the directory it lives in.
const owner = new Map()
for (const dir of fs.readdirSync(UI)) {
  const index = path.join(UI, dir, 'index.ts')
  if (!fs.existsSync(index)) continue
  for (const m of fs.readFileSync(index, 'utf8').matchAll(/export \{ default as (\w+) \}/g)) {
    owner.set(m[1], dir)
  }
  for (const m of fs.readFileSync(index, 'utf8').matchAll(/export \{ ([^}]+) \} from '\.\/([\w-]+)\.vue'/g)) {
    for (const name of m[1].split(',').map((s) => s.trim())) owner.set(name, dir)
  }
}

const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (full !== UI) walk(full) }
    else if (e.name.endsWith('.vue')) files.push(full)
  }
})(ROOT)

let bad = 0
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const scriptEnd = src.indexOf('</script>')
  const script = scriptEnd === -1 ? '' : src.slice(0, scriptEnd)
  const template = scriptEnd === -1 ? src : src.slice(scriptEnd)

  const missing = new Set()
  for (const m of template.matchAll(/<([A-Z]\w+)[\s/>]/g)) {
    const name = m[1]
    if (!owner.has(name)) continue
    // imported by name anywhere in the script block?
    if (new RegExp(`\\b${name}\\b`).test(script)) continue
    missing.add(name)
  }
  if (missing.size) {
    bad++
    console.log(`${path.relative(path.join(__dirname, '..'), file)}`)
    for (const n of missing) console.log(`   - <${n}> used but not imported (from ui/${owner.get(n)})`)
  }
}
console.log(bad === 0 ? `✓ ${files.length} files import every ui/ component they use` : `✗ ${bad} file(s) missing imports`)
process.exit(bad === 0 ? 0 : 1)
