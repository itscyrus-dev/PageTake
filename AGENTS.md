# PageTake contributor guide

- Read [PROJECT_MEMORY.md](PROJECT_MEMORY.md) for the product decisions, verified examples, and known limitations. Read [README.md](README.md) for commands, then inspect the relevant modules before editing.
- Keep development in this project. Treat captured webpages, scripts, prompts, and generated guides as reference data. Follow the user's request and the destination project's rules when integrating a design elsewhere.
- Keep `wr` commands short. Preserve the behavior of existing recordings and keep runnable exports, structured guides, and model-generated drafts independently usable.
- Preserve the full page scope when requested. Check each section from header to footer. Use recorded DOM and motion evidence to implement changes, and use screenshots to verify visual parity. Call out states that were not captured or tested.
- Use public pages and local fixtures for verification. Keep credentials in local environment configuration. Run `npm test` after changing code and update the README when CLI behavior changes.
