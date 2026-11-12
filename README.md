# PageTake

PageTake records public pages in Chrome, replays captured responses offline,
and exports a standalone preview with screenshots, interaction states, motion
timelines, and an asset inventory. Use it to inspect how a page works or
compare an implementation against recorded evidence.

## Requirements

- Node.js 24 or later and Google Chrome.
- On macOS, PageTake looks for Chrome in Applications. On Linux, set
  `CHROME_PATH` to your Chrome executable. The `--chrome` option overrides it.

```sh
npm ci
./wr help
```

## Quick start

```sh
./wr clone https://example.com/ example
./wr open example
./wr score example --headless
```

`clone` scrolls from the top to the bottom over 60 seconds and captures six
screenshots. Use `--seconds`, `--samples`, `--width`, and `--height` to adjust
the capture. Use `--scroll 800:2400` for a pixel range, `--scroll '#section'`
for a selector, or `--scroll manual` to control the browser yourself.

| Command | Result |
| --- | --- |
| `./wr clone <URL> <project>` | Capture into `recordings/<project>/reference` and export into `source` |
| `./wr open <project> [version]` | Serve a preview locally. The default version is `source` |
| `./wr score <project> [version]` | Compare with the reference using the recorded viewport, automatic scroll positions, and action plan |
| `./wr export <project>` | Export an existing recording into a new `source` directory |
| `./wr guide <project> [version]` | Add section guides to an existing export without a `guide` directory |
| `./wr ai <project> [version]` | Generate an independent draft using an API-compatible model |

Choose a fresh project name for each capture. Set `PAGETAKE_DIR` to change the
local recordings directory. Use the lower-level export command to write an
existing capture to another directory.

## Capture motion and interactions

```sh
./wr clone http://127.0.0.1:8080/ workflow --headless --seconds 12 --samples 4 \
  --js-motion --watch '#counter,.sticky-panel' --actions actions.json
```

New captures observe CSS and Web Animations timings, SVG geometry, media
metadata, and semantic component changes. `--watch` samples computed styles,
geometry, and numeric text for extra elements. `--reduced-motion` emulates
the system preference. Use another project and viewport to compare mobile or
reduced-motion behavior.

`--js-motion` observes top-document `requestAnimationFrame` callbacks while
preserving their native timestamps. The exported `manifest/js-motion.json`
contains callback tracks, aggregate frame activity, and watched element
samples on the navigation clock. Correlate these with events and action
frames. The data does not infer which callback wrote a DOM value or recover
a library's internal easing, timers, or worker code.

Actions run after page sampling. An action takes a screenshot before its
trigger and at 0%, 25%, 50%, 75%, and 100% of its observation window.

```json
[
  { "type": "scroll", "selector": "#workflow-tab", "durationMs": 600 },
  {
    "type": "click",
    "selector": "#workflow-tab",
    "durationMs": 1200,
    "state": "workflow-open",
    "expect": { "selector": "#workflow-tab", "attribute": "aria-selected", "value": "true" },
    "canvas": "#stage"
  }
]
```

The action types are `scroll`, `click`, `hover`, `focus`, and `wait`. Use
up to 12 actions with durations from 400 to 10000 ms. `wait` needs no
selector. Scroll targets into view before clicking or hovering.

- **Canvas clips.** Set an action's `canvas` to record the selected canvas
  during that action. It can appear after the trigger. For a standalone
  two-second clip after page sampling and any actions, use `--canvas '#stage'`. The WebM
  captures the canvas pixels at up to 24 fps without audio or surrounding
  DOM. Chrome's canvas stream can fail on tainted or unsupported surfaces.
  Encoding errors are included in the clip manifest.
- **State links.** Add a unique lowercase `state` slug and an `expect`
  attribute check. Use a string for the expected value, or `null` for an
  absent attribute on an existing element. Once verified during capture,
  the successful action prefix can be restored at `/?state=workflow-open`.
  The preview replays the actions and checks the attribute again. Checkpoints
  require same-page actions. Native hover, trusted-only handlers, and
  navigation or form submission are outside live state replay.
- **Evidence viewer.** Open `/manifest/evidence.html` in the export preview
  to follow available state links and play the Canvas clips.

## Replay and compare

```sh
mkdir -p recordings
node pagetake.mjs record https://example.com/ recordings/reference --seconds 12
node pagetake.mjs replay recordings/reference --seconds 12 --output recordings/playback
node pagetake.mjs compare recordings/reference recordings/playback
node pagetake.mjs export recordings/reference recordings/standalone
node recordings/standalone/serve.mjs
```

Offline replay loads the original URL through Chrome and fulfills requests
from the archive. The browser uses a local deny proxy for uncaptured traffic.
A standalone export uses local routes and needs only Node.js to serve. Export
contains captured browser resources, which may include compiled JavaScript.

In a preview, use these query parameters.

| Query | Behavior |
| --- | --- |
| `?section=workflow` | Scroll to an element ID or a URL-encoded selector |
| `?motion=speed&speed=0.25` | Slow supported browser animations |
| `?motion=pause` | Pause supported browser animations |
| `?motion=step&t=250` | Set supported browser animations to 250 ms on their local timelines |
| `?motion=step&t=250&js=1` | Advance a virtual JavaScript frame clock by 250 ms after initialization, then hold |
| `?state=workflow-open` | Restore a verified action checkpoint |

`js=1` also works with speed and pause. It controls the page's frame callbacks
and `performance.now()` after load or checkpoint restoration. Step advances
from that point by at most 10000 ms. Reload to start over. CSS scroll
timelines, media clocks, timers, workers, and callbacks bound outside the
top document can continue independently. Use the normal preview URL for
unmodified runtime behavior.

`compare.html` displays paired screenshots. Its JSON companion includes
page and action scores. Visual scoring combines pixel color and local
structure. Frames must share dimensions and fall within 24 px of scroll
position and 300 ms of elapsed sampling time. Motion scores require two
comparable frames at a stable scroll position. Match the action plan and
viewport when using `inspect` against another implementation.

## Export contents

Start with `guide/page.md` for the section map.

| File under `manifest/` | Contents |
| --- | --- |
| `page.json` | Capture viewport, browser, and sample positions |
| `motion-manifest.json` | CSS and browser animations, keyframes, observed values, and collection limits |
| `js-motion.json` | Opt-in JavaScript frame activity and watched samples |
| `interactions.json` | Observed state transitions, actions, and frame indexes |
| `states.json` | Verified, replayable checkpoints when available |
| `canvas-clips.json` | Clip dimensions, timing, WebM files, and capture errors when requested |
| `styles.json` | Measured styles, boxes, and SVG geometry |
| `assets.json` and `missing.json` | Asset mapping, hashes, media coverage, and missing evidence |

Old captures remain exportable. Their motion manifest is marked `legacy`.
New runtime evidence requires a fresh capture. Capture only covers loaded
public resources. Media byte coverage describes the bytes that were stored,
and browser media metadata is available only after it loads.

## Generate an editable draft

Copy `.env.example` to `.env` and set the model endpoint, model name, and API
key locally using the `PAGETAKE_*` variables. Existing `WEB_REPLAY_*` settings
are also accepted. Then run `./wr ai example` and `./wr open example draft`.
`--prompt-only` saves the prompt locally for inspection. The tool sends
capture evidence to the configured model endpoint only when you request a
model generation call.

Use public pages and fixtures you are authorized to capture. Recording uses a
fresh Chrome profile and filters recognized authentication and signed
requests. Captures can still contain public responses and third-party
materials. The MIT license applies to PageTake's source code. Review the
rights for any captured material before sharing it.

## Contributing and releases

```sh
npm ci
npm test
```

CI runs the Node.js 24 suite with Chrome on Ubuntu and macOS. See
[CONTRIBUTING.md](CONTRIBUTING.md) for development guidance.

To prepare a release, update `package.json` and `package-lock.json` together,
commit the changes, then push the matching `v<version>` tag to your GitHub
repository. The release workflow reruns CI, checks the tag against the
package version, and publishes `pagetake-<version>.tar.gz` with a matching
`.tar.gz.sha256` checksum file. See [GitHub Releases](https://github.com/itscyrus-dev/PageTake/releases)
for published builds.

[MIT License](LICENSE)
