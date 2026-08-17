import { GeneratedPianoEngine } from './generated-piano-engine.js';
import { MissingSamplePackError, PianoSamplePack } from './sample-pack.js';
import { SamplePackPianoEngine } from './sample-piano-engine.js';
import type { PianoEngine, PianoEngineFactoryOptions } from './types.js';

export {
  MissingSamplePackError,
  PianoSamplePack,
  SamplePackNotReadyError,
  SamplePackPreloadError,
  pianoStereoPan,
  samplePlaybackRate,
  selectSampleLayer,
  selectVelocityLayer,
} from './sample-pack.js';
export { SamplePackPianoEngine } from './sample-piano-engine.js';
export type {
  LoadedSampleSelection,
  PianoSampleLayer,
  PianoSampleLayerKind,
  PianoSamplePackOptions,
  PianoSamplePreloadRequest,
} from './sample-pack.js';
export type { SamplePackPianoEngineOptions } from './sample-piano-engine.js';
export {
  createPianoSamplePackFromManifest,
  PianoSampleDecodeError,
} from './sample-manifest.js';
export { samplePreloadRequests } from './sample-preload.js';
export { createBundledSalamanderPianoSamplePack } from './bundled-sample-pack.js';
export { PianoAudioAnalyzer, createMasterAnalyser } from './audio-analyzer.js';
export type { PianoAudioAnalysis, PianoAudioAnalyzerOptions } from './audio-analyzer.js';
export type {
  PianoSampleAsset,
  PianoSampleFetch,
  PianoSampleFetchResponse,
  PianoSampleManifest,
} from './sample-manifest.js';

/**
 * Construct the selected piano source. Selecting `sample-pack` without a pack
 * fails explicitly rather than silently changing the requested sound source.
 */
export function createPianoEngine(options: PianoEngineFactoryOptions = {}): PianoEngine {
  const source = options.source ?? (options.samplePack === undefined ? 'generated' : 'sample-pack');
  if (source === 'sample-pack') {
    if (options.samplePack === undefined) {
      throw new MissingSamplePackError();
    }
    return new SamplePackPianoEngine({
      ...options,
      samplePack: options.samplePack,
    });
  }
  return new GeneratedPianoEngine(options);
}
