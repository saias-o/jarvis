# Font credits

Both faces are licensed **SIL Open Font License 1.1**, which allows use,
embedding and redistribution — including in a commercial product and inside an
APK — as long as the files are not sold on their own and the licence travels
with them.

| Family | Weights | Designer | Used for |
|---|---|---|---|
| **Chakra Petch** | 300, 400, 600 | Cadson Demak | The interface's own voice: titles, status, captions |
| **JetBrains Mono** | 300–400 (variable) | JetBrains | Everything read as data: rails, readouts, the log |

The files are the woff2 that Google Fonts serves, in the `latin` and
`latin-ext` subsets only. Each rule in `src/styles/fonts.css` keeps the
`unicode-range` it came with, so a browser still downloads only the subset a
glyph actually needs — and nothing is fetched from Google at run time.

JetBrains Mono is a variable font: one file covers both weights per subset,
which is why there are eight files for ten rules.

## Why they are here and not imported

An `@import` of `fonts.googleapis.com` cost three round trips before the first
glyph, called on a third party on every load, and never arrived at all on a
phone with no network — a state this app is built to work in. The full
reasoning is at the top of `src/styles/fonts.css`.

## Replacing one

Put the woff2 in this folder and point its rule in `src/styles/fonts.css` at
the new filename. Nothing in the code names a font file.

## Refreshing them

They were taken from the stylesheet at:

```
https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@300;400;600&family=JetBrains+Mono:wght@300;400&display=swap
```

Fetch that with a current browser's user agent (an old one is served ttf
instead of woff2), keep the `latin` and `latin-ext` blocks, and download the
URL from each.
