import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * TRIAL — the Agentation annotation toolbar (try/agentation branch).
 *
 * The toolbar posts annotations to the MCP server's HTTP endpoint, which `default-src 'self'`
 * forbids. Widened HERE rather than in index.html, and only in dev, because the CSP is the spine
 * of this app's security contract: a shipped build must not carry an exception made for a
 * development tool. `apply: 'serve'` is what guarantees that — the packaged build never runs this.
 */
const agentationCsp = {
  name: 'agentation-dev-csp',
  apply: 'serve' as const,
  transformIndexHtml(html: string): string {
    return html.replace(
      "default-src 'self';",
      "default-src 'self'; connect-src 'self' http://localhost:4747;"
    )
  }
}

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
    plugins: [react(), agentationCsp]
  }
})
