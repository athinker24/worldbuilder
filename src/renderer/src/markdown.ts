// Gate 1, in one file: note content is rendered as markdown, and note content arrives inside a
// `.world` somebody else wrote.
//
// This was thirty-seven lines in the middle of EntityPage.tsx, a 1,668-line component that is
// edited whenever a field, a tab or a form changes — which is to say the security boundary lived
// in the file least likely to be read carefully. Nothing about the rules changed in moving it; the
// point is that they are now somewhere a reviewer can see whole, and that `docs/security-gates.md`
// can name a file rather than a line range.
//
// Only `renderMarkdown` leaves this module. The pieces below are deliberately not exported: each
// is safe only in combination with the others, and an escape helper on its own is an invitation to
// use it in a context it was not written for — which is gate 23 exactly (`escapeHtml` is the wrong
// tool inside a `style` attribute).
import { Marked, type Tokens } from 'marked'

// URL schemes allowed in links. marked copies `[click](javascript:…)` into <a href> verbatim;
// clicking it would run code in the renderer context (window.api → the whole database). A
// shared .world can carry that, so an allow-list is mandatory.
// '#' is the wiki links' own href; 'world:' is a local image embedded in a note (![x](world://data/…)).
const SAFE_URL = /^(https?:|world:|mailto:|#)/i
const safeHref = (href: string): string => (SAFE_URL.test(href.trim()) ? href : '#')
// Sanitising at PARSER LEVEL: the URL is checked on the token BEFORE any HTML exists. (The
// previous version regexed href="…" in the generated HTML; correct today, but a marked release
// emitting single quotes or another order would have silently defeated it — cut at the source,
// not filter the output.) escapeAttr: the URL lands inside quotes, and we do not trust
// marked's own escaping.
const escapeAttr = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const safeMarked = new Marked({
  renderer: {
    link(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, token: Tokens.Link) {
      const t = token.title ? ` title="${escapeAttr(token.title)}"` : ''
      const inner = this.parser.parseInline(token.tokens)
      return `<a href="${escapeAttr(safeHref(token.href))}"${t}>${inner}</a>`
    },
    image(token: Tokens.Image) {
      const t = token.title ? ` title="${escapeAttr(token.title)}"` : ''
      return `<img src="${escapeAttr(safeHref(token.href))}" alt="${escapeAttr(token.text)}"${t}>`
    }
  }
})

// [[Entity Name]] → clickable wiki link (converted before markdown)
// '<' is escaped first: raw HTML typed into a note (<img onerror=...> and such) can never
// run as script — content arriving in a shared world.db stays safe too.
export function renderMarkdown(content: string): string {
  const withWiki = content
    .replace(/</g, '&lt;')
    .replace(
      /\[\[([^\]]+)\]\]/g,
      (_, name: string) => `<a href="#" data-wiki="${escapeAttr(name)}">${name}</a>`
    )
  return safeMarked.parse(withWiki, { async: false })
}
