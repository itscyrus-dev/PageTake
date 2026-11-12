# Web Replay project memory

Web Replay is a standalone local tool. The product goal is to capture enough
browser evidence to reproduce a public page and then adapt the design to an
existing frontend. Run commands and consult the schema through the README.

- A request for the full page includes navigation, hero, every intermediate
  section, the final call to action, and the footer.
- Use DOM, computed styles, assets, state changes, and animation evidence
  for implementation. Use screenshots to check parity. Report capture gaps.
- Keep commands short and model endpoints configurable. DeepSeek is one
  example of a compatible API.
- Recordings, runnable exports, structured guides, and model-generated
  drafts serve different workflows and remain independently usable. When
  integrating into a React or Vue project, follow that project's conventions
  and connect its real components and services.

## Local VidMuse evidence

The local-only `recordings/vidmuse-full` project contains a legacy recording of
the public Winning Ads page and a separate React reconstruction under
`source/vidmuse`. The reconstruction is a useful verification fixture. Do
tool development in Web Replay.

A first visit to the Chinese VidMuse page can display an onboarding overlay
that locks scrolling. Automatic capture recognizes the known dialog and
dismisses it. For other dialogs, use the manual capture window.

An earlier visual comparison of the direct VidMuse export reported 92.6
across four comparable frames. Scroll positions changed between samples,
so there was no motion score. That result applies to that specific run.

Later tool verification used the local React fixture at 1440 × 900 and
390 × 844 to exercise full-page capture, workflow tabs, accordion states,
and the collage hover. The older source archive retains its original
page-level evidence.

## Capture boundaries

Automatic scrolling triggers lazy loading along the path. Interaction
branches depend on user actions or an explicit action plan. Compare motion
at matching viewport, scroll position, action, and time. Browser sampling
and frame callback tracing do not recover arbitrary application state.

Keep API credentials in the local environment. Use public pages and
synthetic fixtures for testing. The Git repository excludes local
recordings, export artifacts, and environment files.
