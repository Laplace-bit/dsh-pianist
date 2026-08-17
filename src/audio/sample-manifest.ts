import {
  PianoSamplePack,
  type PianoSampleLayer,
  type PianoSampleLayerKind,
  type PianoSamplePackOptions,
} from './sample-pack.js';

/** Serializable package metadata for recorded piano assets. */
export interface PianoSampleAsset {
  readonly id: string;
  readonly url: string;
  readonly rootMidi: number;
  readonly velocity: number;
  readonly kind?: PianoSampleLayerKind;
}

/** A browser-independent manifest that never embeds large audio data in DOM attributes. */
export interface PianoSampleManifest {
  readonly id: string;
  readonly version: string;
  readonly layers: readonly PianoSampleAsset[];
  readonly cache?: PianoSamplePackOptions;
}

export interface PianoSampleFetchResponse {
  readonly ok: boolean;
  readonly status?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type PianoSampleFetch = (url: string) => Promise<PianoSampleFetchResponse>;

/** Error type that keeps a failing URL out of normal playback fallback logic. */
export class PianoSampleDecodeError extends Error {
  constructor(readonly layerId: string, readonly url: string, cause: unknown) {
    super(`Unable to fetch or decode piano sample ${JSON.stringify(layerId)}`);
    this.name = 'PianoSampleDecodeError';
    this.cause = cause;
  }
}

function assertAsset(asset: PianoSampleAsset): void {
  if (typeof asset.url !== 'string' || asset.url.trim() === '') {
    throw new TypeError(`Piano sample ${JSON.stringify(asset.id)} requires a non-empty URL`);
  }
  if (asset.kind !== undefined
    && asset.kind !== 'attack'
    && asset.kind !== 'release'
    && asset.kind !== 'resonance'
    && asset.kind !== 'pedal-down'
    && asset.kind !== 'pedal-up') {
    throw new RangeError(`Piano sample ${JSON.stringify(asset.id)} has an invalid kind`);
  }
}

function defaultFetch(url: string): Promise<PianoSampleFetchResponse> {
  if (typeof fetch !== 'function') {
    return Promise.reject(new Error('fetch is unavailable for piano sample loading'));
  }
  return fetch(url) as Promise<PianoSampleFetchResponse>;
}

/**
 * Create a loader-backed pack from a manifest. `decodeAudioData()` executes
 * only after a caller creates/unlocks an AudioContext, preserving browser
 * gesture requirements and avoiding a base64/HTML transport path.
 */
export function createPianoSamplePackFromManifest(
  manifest: PianoSampleManifest,
  fetchSample: PianoSampleFetch = defaultFetch,
): PianoSamplePack {
  if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
    throw new TypeError('Piano sample manifest requires a non-empty id');
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new TypeError('Piano sample manifest requires a non-empty version');
  }
  const layers: PianoSampleLayer[] = manifest.layers.map((asset) => {
    assertAsset(asset);
    return {
      id: asset.id,
      rootMidi: asset.rootMidi,
      velocity: asset.velocity,
      kind: asset.kind,
      load: async (context) => {
        try {
          const response = await fetchSample(asset.url);
          if (!response.ok) {
            throw new Error(`HTTP ${String(response.status ?? 'error')}`);
          }
          // Some browser engines detach the input ArrayBuffer during decode;
          // cloning keeps retry behavior deterministic for a custom fetcher.
          const encoded = await response.arrayBuffer();
          return await context.decodeAudioData(encoded.slice(0));
        } catch (error) {
          throw new PianoSampleDecodeError(asset.id, asset.url, error);
        }
      },
    };
  });
  return new PianoSamplePack(layers, manifest.cache);
}
