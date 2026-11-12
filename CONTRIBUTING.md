# Contributing

Install Node.js 24 and Google Chrome, then run `npm ci` and `npm test`. Set
`CHROME_PATH` if Chrome is installed outside the default location. Use public
pages and local fixtures that can be shared when reproducing issues.

Keep CLI options short and document changes in the README. Preserve support
for older archives and test any change to capture, export, or replay through
the normal CLI entry points. If your change affects visual output, check the
relevant states and viewports and note the scope of your verification.

Keep credentials, captured responses, exported pages, and recordings out of
commits. For bug reports, share the command, expected and observed behavior,
Node and Chrome versions, and a minimal public reproduction when available.

## Source layout

- `wr`, `web-replay.mjs`, and `serve.mjs` are the entry points.
- `src/capture/` contains Chrome integration, network capture, and sampling.
- `src/export/` writes runnable packages, manifests, and section guides.
- `src/preview/` contains the standalone server and browser controls.
- `src/compare/` scores captures and renders reports.
- `src/generate.mjs` prepares evidence and saves model-generated drafts.
- `test/` contains unit and Chrome integration tests.

The project uses native JavaScript modules and JSDoc contracts for shared
action data. Exported previews run directly with Node and the browser.
