# Contributing to dsh-pianist

Thanks for taking the time to contribute. This project is small by design and
keeps two invariants that every change must respect.

## Design invariants

1. **Determinism.** Audio, canvas, particles, and the keyboard must never invent
   their own musical time. New ambient or effect work should use seeded
   randomness and read musical time from the shared `MusicalClock`, never
   `Math.random()` or a private per-frame clock.
2. **Skin-driven rendering.** The piano renderer consumes pure `PianoSkin`
   data (material, lighting, atmosphere). Add appearance as data in
   `src/visual/skin.ts`; only add a new render branch in
   `src/visual/immersive-scene.ts` when a genuinely new geometry is required.

## Setup

```bash
pnpm install
pnpm run test
pnpm run typecheck
pnpm run build
```

Do not mix `npm install` with pnpm in this workspace. See the [README](./README.md#development).

## Reporting issues

Include:

- The exact score or tool payload that triggered the problem.
- Browser and OS version, and whether the bug reproduces in the
  [static demo](./docs/index.html).
- For visual bugs, the skin family and render mode (`immersive` vs `embedded`).
- For determinism bugs, whether pause/seek/replay also diverge.

## Pull requests

- Run `pnpm run test`, `pnpm run typecheck`, and `pnpm run build` before
  opening the PR.
- Add tests for new behavior. The suite covers the deterministic core,
  clock/scheduler, audio and sample packs, visual state/renderer, sync
  metrics, and the DSH host/policy boundary.
- Keep changes focused. If a fix touches the renderer, prefer a skin-data-only
  change when one exists.

## Code style

- TypeScript, strict mode, no runtime dependencies beyond the declared ones.
- Tests live in `test/` using Vitest.
- No unused code or dead branches; delete rather than comment out.

## License

By contributing you agree that your contributions are licensed under the
project's MIT license.
