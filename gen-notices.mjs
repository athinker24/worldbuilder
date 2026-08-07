/**
 * Builds THIRD-PARTY-NOTICES.txt from the packages that are actually SHIPPED.
 *
 * MIT and BSD both require their copyright notice to travel with the binary, and OFL-1.1 (the four
 * fonts) requires the licence text itself to be distributed with the font. electron-builder already
 * drops LICENSE.electron.txt and LICENSES.chromium.html next to the exe — those cover Electron,
 * Chromium and ffmpeg, and nothing here needs to repeat them. What it does NOT cover is anything
 * inside app.asar, which is every package below.
 *
 * The list is DERIVED, not hand-written: `dependencies` from package.json, plus the handful of
 * devDependencies that Vite inlines into the renderer bundle. A dependency added later shows up
 * here on the next run; one that stops shipping disappears. Hand-written, this file would be wrong
 * within a month and nobody would notice, because nothing about a stale notice file fails.
 *
 * Run it after touching dependencies:  node gen-notices.mjs
 * It rewrites the file in place and prints what changed.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { dirname, join } from 'path'

// Bundled by Vite from devDependencies — they are in the renderer bundle just as much as anything
// in `dependencies`, and the licence does not care which section of package.json a package sat in.
const BUNDLED_DEV = ['react', 'react-dom', 'scheduler']

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

/**
 * The WHOLE tree, not the top of it. leaflet-geoman pulls in a dozen @turf packages and they are
 * bundled into the renderer exactly like anything named in package.json — a licence obligation does
 * not stop at the first level, and the first version of this file only walked the roots and quietly
 * shipped without them. Resolution walks up through nested node_modules the way Node does, since a
 * conflicting version can sit beside its dependent rather than at the top.
 */
const resolvePkg = (name, fromDir) => {
  let dir = fromDir
  for (;;) {
    const cand = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(join(cand, 'package.json'))) return cand
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

const found = new Map() // name → directory
const walk = (name, fromDir) => {
  if (found.has(name)) return
  const dir = resolvePkg(name, fromDir)
  if (!dir) {
    missing.push(`${name} (could not be resolved from ${fromDir})`)
    return
  }
  found.set(name, dir)
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  for (const dep of Object.keys(meta.dependencies ?? {})) walk(dep, dir)
}

const missing = []
for (const n of [...Object.keys(pkg.dependencies ?? {}), ...BUNDLED_DEV]) walk(n, process.cwd())
const names = [...found.keys()].sort()
// The product name lives in electron-builder.yml, not package.json. One line of regex beats a YAML
// parser for one field, and reading it keeps the name in a single place.
const productName =
  /^productName:\s*(.+)$/m.exec(readFileSync('electron-builder.yml', 'utf8'))?.[1].trim() ??
  pkg.name

const licenceText = (dir) => {
  const hit = readdirSync(dir).find((f) => /^(licen[cs]e|copying)($|[.-])/i.test(f))
  return hit ? readFileSync(join(dir, hit), 'utf8').replace(/\r\n/g, '\n').trim() : null
}

// The canonical MIT text, for the one case below. Not a way to paper over a missing licence: it is
// only ever used with a copyright holder the package itself names.
const MIT_TEXT = `MIT License

Copyright (c) %HOLDER%

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

/**
 * Some packages declare a licence in package.json and ship no licence FILE — @pixi/colord is one.
 * Omitting it is not an option (it is distributed, so its notice is required) and neither is
 * inventing anything, so the text is reconstructed from what the publisher themselves declared:
 * the SPDX id and the named author, who is the copyright holder. The block says plainly that this
 * is what happened, and points at the upstream repository so it can be checked.
 *
 * MIT only, deliberately. Any other licence with no text is a hard failure — the whole value of
 * this file is that a gap in it is loud.
 */
const reconstructed = (meta) => {
  const holder = typeof meta.author === 'string' ? meta.author : meta.author?.name
  if (meta.license !== 'MIT' || !holder) return null
  const repo = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url
  return (
    `NOTE: this package ships no licence file. The text below is the standard MIT licence\n` +
    `with the copyright holder named by the package itself` +
    `${repo ? ` (upstream: ${repo})` : ''}.\n\n` +
    MIT_TEXT.replace('%HOLDER%', holder)
  )
}

const blocks = []
for (const name of names) {
  const dir = found.get(name)
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const text = licenceText(dir) ?? reconstructed(meta)
  if (!text) {
    // Loud, not silent: a package whose licence text cannot be found is the one case this file
    // exists to prevent, and a missing block looks exactly like a package that was never used.
    missing.push(`${name} (${meta.license ?? 'licence unknown'} — no licence file in the package)`)
    continue
  }
  blocks.push(
    `${'-'.repeat(78)}\n${name} ${meta.version}` +
      `${meta.homepage ? `\n${meta.homepage}` : ''}\nLicence: ${meta.license ?? 'see below'}\n` +
      `${'-'.repeat(78)}\n\n${text}\n`
  )
}

const out = `THIRD-PARTY NOTICES
${'='.repeat(78)}

${productName} includes the open source components listed below. Each is used
under its own licence, reproduced in full. Nothing here restricts what you may do with the
worlds you make; it covers the code the application is built from.

Electron, Chromium and ffmpeg are covered separately by LICENSE.electron.txt and
LICENSES.chromium.html, which sit beside the application executable.

Generated by gen-notices.mjs from the installed dependency tree. Do not edit by hand.

${blocks.join('\n')}`

writeFileSync('THIRD-PARTY-NOTICES.txt', out.replace(/\n/g, '\r\n'))
console.log(`wrote THIRD-PARTY-NOTICES.txt — ${blocks.length} packages`)
for (const n of names) console.log('  ' + n)
if (missing.length) {
  console.error('\nMISSING LICENCE TEXT:')
  for (const m of missing) console.error('  ' + m)
  process.exit(1) // a notice file with a hole in it is worse than none: it reads as complete
}
