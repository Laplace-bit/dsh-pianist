/**
 * Deterministic PCM generator for the built-in fallback piano voice.
 *
 * This is intentionally sample-based (an AudioBuffer per note/velocity layer)
 * rather than a live oscillator patch. It remains a small, dependency-free
 * fallback when the bundled or embedding-provided recorded pack is unavailable.
 */

export interface GeneratedPianoToneOptions {
  sampleRate: number;
  midi: number;
  velocity: number;
  durationSeconds: number;
}

const A4_MIDI = 69;
const A4_FREQUENCY = 440;

export function midiToFrequency(midi: number): number {
  return A4_FREQUENCY * Math.pow(2, (midi - A4_MIDI) / 12);
}

/**
 * Generate a deterministic piano-like tone.
 *
 * The synthesis uses:
 * - inharmonic partials (stretched high harmonics)
 * - velocity-dependent brightness
 * - exponential decay
 * - a short attack ramp
 * - a tiny amount of mechanical attack noise
 */
export function generatePianoTone(options: GeneratedPianoToneOptions): Float32Array {
  const { sampleRate, midi, velocity, durationSeconds } = options;
  const length = Math.max(1, Math.floor(sampleRate * durationSeconds));
  const data = new Float32Array(length);
  const baseFrequency = midiToFrequency(midi);
  const inharmonicity = 0.0004 + (midi - 21) * 0.00001;
  const brightness = 0.25 + velocity * 0.75;
  const partials = 12;
  const decaySeconds = Math.min(6, 0.8 + (108 - midi) * 0.055);
  const attackSamples = Math.max(1, Math.floor(sampleRate * 0.003));
  const noiseAmp = 0.012 * velocity;

  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    let sample = 0;
    for (let p = 1; p <= partials; p += 1) {
      const freq = baseFrequency * p * Math.sqrt(1 + inharmonicity * p * p);
      const amplitude = Math.pow(1 / p, 1.6 + (1 - brightness) * 0.7) * (1 + brightness * 0.3 * p / partials);
      sample += Math.sin(2 * Math.PI * freq * t) * amplitude;
    }
    const envelope = Math.exp(-t / decaySeconds);
    const attack = i < attackSamples ? i / attackSamples : 1;
    // Deterministic low-passed noise burst (no Math.random).
    const noisePhase = Math.sin(2 * Math.PI * 73 * t) * Math.sin(2 * Math.PI * 157 * t + 1.3);
    const noise = noisePhase * noiseAmp * Math.exp(-t / 0.012);
    data[i] = (sample * envelope * attack + noise) * velocity;
  }

  // Simple DC removal.
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    sum += data[i];
  }
  const dc = sum / data.length;
  for (let i = 0; i < data.length; i += 1) {
    data[i] -= dc;
  }

  return data;
}
