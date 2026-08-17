import { SALAMANDER_SAMPLE_ASSETS } from '../shared/salamander-samples.js';
import { createPianoSamplePackFromManifest } from './sample-manifest.js';
import type { PianoSamplePack } from './sample-pack.js';

/** Build the lazy, fetch-backed pack shipped with the plugin. */
export function createBundledSalamanderPianoSamplePack(): PianoSamplePack {
  return createPianoSamplePackFromManifest({
    id: 'salamander-grand-piano-v3',
    version: '3-mp3.1.0.5',
    layers: SALAMANDER_SAMPLE_ASSETS.map(({ id, url, rootMidi, velocity, kind }) => ({
      id,
      url,
      rootMidi,
      velocity,
      kind,
    })),
  });
}

/**
 * Build the same Salamander pack with caller-owned URLs, for standalone demos
 * that do not run the DSH Host sample route (e.g. a CDN mirror of the
 * `@audio-samples/piano-mp3-*` packages).
 */
export function createSalamanderSamplePack(
  urlFor: (packageName: string, fileName: string) => string,
): PianoSamplePack {
  return createPianoSamplePackFromManifest({
    id: 'salamander-grand-piano-v3',
    version: '3-mp3.1.0.5',
    layers: SALAMANDER_SAMPLE_ASSETS.map(({ id, packageName, fileName, rootMidi, velocity, kind }) => ({
      id,
      url: urlFor(packageName, fileName),
      rootMidi,
      velocity,
      kind,
    })),
  });
}
