/** HTTP prefix owned by the Host for bundled Salamander piano recordings. */
export const SALAMANDER_SAMPLE_ROUTE = '/plugins/dsh-pianist/samples';

/** Roles used by the browser sample engine. */
export type SalamanderSampleKind =
  | 'attack'
  | 'release'
  | 'resonance'
  | 'pedal-down'
  | 'pedal-up';

/** One allowlisted npm asset and its browser playback metadata. */
export interface SalamanderSampleAsset {
  readonly id: string;
  readonly packageName: string;
  readonly packageSegment: string;
  readonly fileName: string;
  readonly url: string;
  readonly rootMidi: number;
  readonly velocity: number;
  readonly kind: SalamanderSampleKind;
}

const VELOCITY_LAYERS = [1, 4, 7, 10, 13, 16] as const;
const ATTACK_ROOTS = [
  ['A0', 21],
  ['C1', 24], ['D#1', 27], ['F#1', 30], ['A1', 33],
  ['C2', 36], ['D#2', 39], ['F#2', 42], ['A2', 45],
  ['C3', 48], ['D#3', 51], ['F#3', 54], ['A3', 57],
  ['C4', 60], ['D#4', 63], ['F#4', 66], ['A4', 69],
  ['C5', 72], ['D#5', 75], ['F#5', 78], ['A5', 81],
  ['C6', 84], ['D#6', 87], ['F#6', 90], ['A6', 93],
  ['C7', 96], ['D#7', 99], ['F#7', 102], ['A7', 105],
  ['C8', 108],
] as const;
const RESONANCE_ROOTS = ATTACK_ROOTS.filter(([name]) => {
  const octave = Number(name.at(-1));
  if (name.startsWith('A')) return octave <= 5;
  if (name.startsWith('F#')) return octave <= 5;
  return octave <= 6;
});
const RESONANCE_LAYERS = [
  ['S', 0.3],
  ['V3', 0.6],
  ['L', 0.9],
] as const;

function asset(
  packageSegment: string,
  fileName: string,
  rootMidi: number,
  velocity: number,
  kind: SalamanderSampleKind,
): SalamanderSampleAsset {
  const packageName = packageSegment === 'harmonics' || packageSegment === 'pedals' || packageSegment === 'release'
    ? `@audio-samples/piano-mp3-${packageSegment}`
    : `@audio-samples/piano-mp3-velocity${packageSegment}`;
  return Object.freeze({
    id: `${kind}:${packageSegment}:${fileName}`,
    packageName,
    packageSegment,
    fileName,
    url: `${SALAMANDER_SAMPLE_ROUTE}/${packageSegment}/${encodeURIComponent(fileName)}`,
    rootMidi,
    velocity,
    kind,
  });
}

function attackAssets(): SalamanderSampleAsset[] {
  return VELOCITY_LAYERS.flatMap(layer => ATTACK_ROOTS.map(([name, midi]) =>
    asset(String(layer), `${name}v${String(layer)}.mp3`, midi, layer / 16, 'attack')));
}

function releaseAssets(): SalamanderSampleAsset[] {
  return Array.from({ length: 88 }, (_, index) =>
    asset('release', `rel${String(index + 1)}.mp3`, index + 21, 0.5, 'release'));
}

function resonanceAssets(): SalamanderSampleAsset[] {
  return RESONANCE_LAYERS.flatMap(([layer, velocity]) => RESONANCE_ROOTS.map(([name, midi]) =>
    asset('harmonics', `harm${layer}${name}.mp3`, midi, velocity, 'resonance')));
}

function pedalAssets(): SalamanderSampleAsset[] {
  return [
    asset('pedals', 'pedalD1.mp3', 60, 0.35, 'pedal-down'),
    asset('pedals', 'pedalD2.mp3', 60, 0.8, 'pedal-down'),
    asset('pedals', 'pedalU1.mp3', 60, 0.35, 'pedal-up'),
    asset('pedals', 'pedalU2.mp3', 60, 0.8, 'pedal-up'),
  ];
}

/** Complete immutable catalog shared by the Host allowlist and browser manifest. */
export const SALAMANDER_SAMPLE_ASSETS: readonly SalamanderSampleAsset[] = Object.freeze([
  ...attackAssets(),
  ...releaseAssets(),
  ...resonanceAssets(),
  ...pedalAssets(),
]);
