# dsh-pianist

[中文](./README.md) · [English](./README.en.md)

dsh-pianist brings a piano-playing Agent to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) Web UI: tired of coding? Ask the AI to play a tune and relax. How well it plays is entirely up to the model. A toy — and also an exam.

Project home page: <https://laplace-bit.github.io/dsh-pianist/>

[![npm](https://img.shields.io/npm/v/dsh-pianist)](https://www.npmjs.com/package/dsh-pianist)
[![License: MIT](https://img.shields.io/badge/license-MIT-8a5818.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-3178c6.svg)](./CONTRIBUTING.md)

## The result

[![dsh-pianist showreel](docs/og-cover.png)](./docs/showreel.mp4)

Click the cover above to watch the showreel ([`docs/showreel.mp4`](./docs/showreel.mp4)), or visit the [online demo](https://laplace-bit.github.io/dsh-pianist/), pick a piece, and hear it rendered in real time.

## What it sounds like

- The timbre comes from real recorded samples of Salamander Grand Piano V3 — six velocity layers, key release, string resonance, pedal action — not synth "beeps".
- Two swappable skins: Obsidian & Gold (a black glossy grand with warm gold trim; keys flash gold on impact) and Sakura Pearl (a pearl-white body with rose-gold details under a sakura-tinted skylight).
- A full-screen immersive stage with waterfall notes, rippling reflections, shooting stars and mist that rise and fall with the performance.
- All 88 keys are playable: mouse glissando, computer keyboard, arrow-key note selection — play it yourself if you like.
- Underneath it all is a deterministic timeline. Pause, scrub, replay — the same score plays back identically every time. That is what makes it an exam paper: whether the model can really play becomes obvious the moment it tries.

## Installation

In the DeepSeek Harness source repository:

```sh
pnpm dsh plugin --profile web add dsh-pianist
```

If `dsh` is already on your `PATH`:

```sh
dsh plugin --profile web add dsh-pianist
```

The npm package ships prebuilt artifacts — usable right after install.

Then start the UI:

```sh
pnpm dsh web
```

To uninstall: `pnpm dsh plugin --profile web remove dsh-pianist`.

## Kernel Compatibility

| DSH kernel | This plugin |
|---|---|
| 0.1.0-rc.5 - 0.1.0-rc.7 | ✅ all versions |
| 0.1.1-rc.2 | ✅ all versions |
| 0.1.2-alpha.1 - 0.1.2-alpha.3 | ✅ 0.1.0 (build with the 2026-09-01 compat fix); earlier releases fail to load on 0.1.2 |

- ✅ = compatible. `0.1.2-alpha.3` is the current host kernel and has been verified live (built-artifact import + test suites); the remaining kernels are covered by the dual-kernel-compatible design (one build, one API surface).
- **Kernel 0.1.2 removed the `settingsNamespace()` runtime helper** (on ≤ 0.1.1 it was a validating identity function; 0.1.2 keeps only the same-named type). This plugin does not statically import that symbol any more — it inlines its namespace constant locally and asserts it as the `SettingsNamespace` type, which works on both old and new kernels.
- The current build no longer statically imports `settingsNamespace()`; earlier releases only work on kernels ≤ 0.1.1 — rebuild or update to a build that contains the fix.
- **Never statically import runtime symbols from `@deepseek-ai/*` packages.** The host CLI starts via `node --import tsx/esm`, and tsx applies the host `tsconfig` `paths` mapping, so a bare `@deepseek-ai/*` import from an external plugin may be redirected into the host's own sources — any host-side rename or removal then explodes at boot as a module instantiation error. Type-only imports (`import type`) are unaffected.

## Usage

Once installed, just request a song in natural language; the Agent hands the full score to the piano:

```text
Play the first eight bars of Ode to Joy, both hands, with sustain pedal.
A C-major scale at 100 BPM, slowed down a little.
Improvise something light and cheerful to help me unwind.
```

The browser may require one manual click on the play button before sound comes out — that is the browser's autoplay policy, not a bug.

The **Settings → Plugins → Pianist** card lets you adjust at any time:

- Enable/disable the plugin and switch skins (Obsidian & Gold / Sakura Pearl);
- Immersive stage or chat-card form; it returns to the card automatically when a piece ends;
- Quality (low/medium/high), volume, waterfall notes, pedal and particle-effect toggles.

Changes apply as soon as you save.

## License

Plugin code is MIT. The bundled piano recordings come from Salamander Grand Piano V3 (CC BY 3.0); see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for attribution.

<details>
<summary>For developers (browser embedding / local demo)</summary>

A standalone web page can import the package via npm and register the Web Component:

```ts
import { registerDshPianoView } from 'dsh-pianist/demo';
registerDshPianoView();
// <dsh-piano-view> exposes public APIs such as setScore / setPianistSettings /
// play / pause / seek / setRate / requestImmersive.
```

The settings card is registered under Settings → Plugins via `settings.plugin.item`. For a local preview landing page, see [`docs/index.html`](./docs/index.html): `pnpm run build && pnpm dlx serve .`.

</details>
