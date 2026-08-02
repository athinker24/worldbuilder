import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    // Function names survive minification, which is what keeps an error report readable in the
    // build a user actually runs. React builds its component stack from `fn.name`, so without this
    // the `screen` row of a crash report — the field that names the screen that broke, and the one
    // that has been most useful in practice — comes out as `at Ln < at Bt < at qe`. In dev nothing
    // is minified, so the problem is invisible exactly where it would be noticed.
    // Costs a few KB and nothing at runtime. File and line numbers in the raw stack stay minified;
    // fixing those needs sourcemaps, which ship megabytes and the source with them — not worth it
    // until an unreadable stack from a packaged build actually costs us something.
    esbuild: { keepNames: true },
    plugins: [react()]
  }
})
