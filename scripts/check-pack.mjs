// What actually ships, checked by listing the built archive rather than reading the config that
// makes it — the only way this class of mistake has ever been caught here. `electron-builder.yml`
// SAYS what is excluded; this asks the archive whether that held. It found graphify-out/ (a 2.9 MB
// dump of this codebase's own architecture and security notes) shipping inside app.asar despite a
// `files:` list that was written specifically to keep exactly that kind of thing out — gitignored,
// so a git-based review never saw it, and .gitignore has no effect on electron-builder.
//
// The bar: every top-level entry in app.asar is one of the four things this app is supposed to
// ship (its own build output, its runtime dependencies, its one bundled resource, its manifest).
// Anything else — a dev tool, a doc, a cache, a future mistake shaped like this one — fails the
// build instead of riding along silently.
//
// Run from the repository root after `npm run build:unpack` or `npm run build:win`:
//   node scripts/check-pack.mjs
// The paths below are relative to the working directory, not to this file.
import { listPackage } from '@electron/asar'
import { existsSync } from 'fs'
import { join } from 'path'

const ARCHIVE = join('dist', 'win-unpacked', 'resources', 'app.asar')
const ALLOW_DIRS = ['out', 'node_modules', 'resources']
const ALLOW_FILES = ['package.json']

if (!existsSync(ARCHIVE)) {
  console.error(
    `FAIL: ${ARCHIVE} not found — run "npm run build:unpack" or "npm run build:win" first`
  )
  process.exit(1)
}

const entries = listPackage(ARCHIVE, {})
// A real build has thousands of entries (node_modules alone sees to that). A near-empty list means
// listPackage or the build silently produced nothing worth checking — a vacuous pass here would be
// worse than no check at all, the same lesson check-corrupt.mjs's own shape check exists for.
if (entries.length < 100) {
  console.error(
    `FAIL: only ${entries.length} entries in the archive — it may be empty or unreadable`
  )
  process.exit(1)
}

const bad = []
for (const entry of entries) {
  const parts = entry.split(/[\\/]/).filter(Boolean)
  const top = parts[0]
  if (!top) continue // the archive root itself
  if (ALLOW_DIRS.includes(top)) continue
  if (parts.length === 1 && ALLOW_FILES.includes(top)) continue
  bad.push(entry)
}

if (bad.length) {
  console.error(
    `FAIL: ${bad.length} unexpected entr${bad.length === 1 ? 'y' : 'ies'} in the packaged app:`
  )
  for (const b of bad.slice(0, 20)) console.error('  ' + b)
  if (bad.length > 20) console.error(`  … and ${bad.length - 20} more`)
  process.exit(1)
}
console.log(
  `ok  ${entries.length} entries, all under out/, node_modules/, resources/ or package.json`
)
