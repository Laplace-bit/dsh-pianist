/**
 * Browser-only public entry point for a static demo or an embedding site.
 * Unlike the package root, it does not evaluate the Cordis Host entry.
 */
export { DshPianoView, registerDshPianoView } from './plugin/view.js';
export { createPianoSamplePackFromManifest } from './audio/sample-manifest.js';
export { createSalamanderSamplePack } from './audio/bundled-sample-pack.js';
export { createMasterAnalyser, PianoAudioAnalyzer } from './audio/audio-analyzer.js';
export type {
  PianistAudioRuntimeErrorCode,
  PianistAudioRuntimeErrorDetail,
  PianistAudioSourceStatus,
  PianistImmersiveCommand,
  PianistParticleEventDetail,
  PianistPerformanceEventDetail,
  PianistRenderModeDetail,
  PianistRenderModeReason,
  PianistViewSettingsResult,
} from './plugin/view.js';
export type { PianistRenderMode } from './plugin/config.js';
export type { PianoAudioAnalysis } from './audio/audio-analyzer.js';
export { buildTimeline } from './core/timeline.js';
export type { Score } from './core/types.js';
