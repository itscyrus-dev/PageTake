# PageTake

PageTake records public web pages and exports a local reference bundle with
screenshots, interaction states, motion timelines, and assets. Hand the bundle
to your coding agent to implement the design in your own project.

## Requirements

- Node.js 24 or later and Google Chrome.
- On macOS, PageTake looks for Chrome in Applications. On Linux, set
  `CHROME_PATH` to your Chrome executable. The `--chrome` option overrides it.

```sh
npm ci
./pagetake help
```

## Capture and hand off to a coding agent

Paste this into your coding agent from the destination project and replace
the placeholders.

> Install the PageTake Skill with `npx skills add itscyrus-dev/PageTake --skill pagetake`, then use PageTake to capture `<public URL>` or open `<export directory>`, implement `<what to recreate>` in this project, and verify it against the capture.

### Manual setup and handoff

1. From the PageTake checkout, record the reference.

   ```sh
   ./pagetake clone https://example.com/ example
   ```

2. From the destination project, install the PageTake Skill for your agent.
   The installer lets you choose which coding agent to install it for.

   ```sh
   npx skills add itscyrus-dev/PageTake --skill pagetake
   ```

3. Give the agent the path to `recordings/example/source` in your PageTake
   checkout, or copy that directory to a location the agent can read. For
   example, ask it to use PageTake to implement the recorded workflow section
   in the current project and verify it at the recorded viewport. The bundle's
   `manifest/agent.json` points to the evidence. Agents can also use the
   bundle's `AGENTS.md` and `guide/page.md` directly.

The destination agent uses its own model access. The Skill installs workflow
instructions. For a new capture, use the PageTake checkout and browser
requirements above.

### Preview and capture options

```sh
./pagetake clone https://example.com/ example
./pagetake open example
./pagetake score example --headless
```

`clone` scrolls from the top to the bottom over 60 seconds and captures six
screenshots. Use `--seconds`, `--samples`, `--width`, and `--height` to adjust
the capture. Use `--scroll 800:2400` for a pixel range, `--scroll '#section'`
for a selector, or `--scroll manual` to control the browser yourself.

| Command | Result |
| --- | --- |
| `./pagetake clone <URL> <project>` | Capture into `recordings/<project>/reference` and export into `source` |
| `./pagetake open <project> [version]` | Serve a preview locally. The default version is `source` |
| `./pagetake score <project> [version]` | Compare with the reference using the recorded viewport, automatic scroll positions, and action plan |
| `./pagetake export <project>` | Export an existing recording into a new `source` directory |
| `./pagetake guide <project> [version]` | Add section guides to an existing export without a `guide` directory |

Choose a fresh project name for each capture. Set `PAGETAKE_DIR` to change the
local recordings directory. Use the lower-level export command to write an
existing capture to another directory.

## Capture motion and interactions

```sh
./pagetake clone http://127.0.0.1:8080/ workflow --headless --seconds 12 --samples 4 \
  --js-motion --watch '#counter,.sticky-panel' --actions actions.json
```

New captures observe CSS and Web Animations timings, SVG geometry, media
metadata, and semantic component changes. `--watch` samples computed styles,
geometry, and numeric text for extra elements. Use `--reduced-motion` or
`--no-reduced-motion` to override the system preference. Scoring reuses the
recorded preference when available. Use another project and viewport to
compare mobile or reduced-motion behavior.

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
| `agent.json` | Entry points, evidence paths, screenshot indexes, verified states, and capture coverage. Paths are relative to the export root |
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

## Optional model-backed draft

Existing users of `./pagetake ai example` can set `PAGETAKE_BASE_URL`,
`PAGETAKE_MODEL`, and `PAGETAKE_API_KEY` in their environment or local `.env`
file. Existing `WEB_REPLAY_*` settings are also accepted. Open the generated
draft with `./pagetake open example draft`.
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
package version, generates notes from commits since the previous published
release, and publishes `pagetake-<version>.tar.gz` with a matching
`.tar.gz.sha256` checksum file. See [GitHub Releases](https://github.com/itscyrus-dev/PageTake/releases)
for published builds.

[MIT License](LICENSE)
