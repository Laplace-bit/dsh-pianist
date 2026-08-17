/**
 * Data-only piano skin registry.
 *
 * A skin family is intentionally shared by the chat and immersive
 * presentations. The renderer owns geometry; this module owns material,
 * lighting and atmosphere tokens so new families never require a new render
 * branch.
 */

export type PianoSkinId = 'lacquer-gold' | 'seaside-glass';
export type PianoSkinCompatId = 'porcelain' | 'celadon' | 'moonlit' | 'dawn';
export type Rgb = readonly [number, number, number];

export interface PianoSkinBackdrop {
  readonly top: string;
  readonly mid: string;
  readonly bottom: string;
  readonly horizon: Rgb;
  readonly horizonAlpha: number;
  readonly vignette: number;
}

export interface PianoSkinCase {
  readonly lidTop: string;
  readonly lidMid: string;
  readonly lidBottom: string;
  readonly edge: string;
  readonly inlay: string;
  /** The thin accent felt runner between fallboard and key tops. */
  readonly feltStrip: string;
  readonly fallboardTop: string;
  readonly fallboardBottom: string;
  readonly fallboardSheen: string;
  readonly keybedTop: string;
  readonly keybedBottom: string;
  readonly keybedShadow: string;
  readonly railTop: string;
  readonly railBottom: string;
  readonly engraving: readonly [string, string, string];
  readonly wood: boolean;
}

/** Material tokens for the complete grand-piano silhouette. */
export interface PianoSkinGrand {
  readonly shell: string;
  readonly shellDeep: string;
  readonly shellHighlight: string;
  readonly interior: string;
  readonly trim: string;
  readonly hardware: string;
  readonly lid: string;
  readonly lidInner: string;
  readonly lidEdge: string;
  readonly prop: string;
  readonly stand: string;
  readonly leg: string;
  readonly pedal: string;
  readonly bench: string;
  readonly benchTop: string;
  readonly line: string;
  readonly lineStrong: string;
  readonly transparent: boolean;
  readonly glowAlpha: number;
}

export interface PianoSkinKeys {
  readonly whiteTop: string;
  readonly whiteMid: string;
  readonly whiteBottom: string;
  readonly whiteShade: Rgb;
  readonly blackTop: string;
  readonly blackBody: string;
  readonly blackBottom: string;
  readonly blackTip: string;
  readonly pressedWhiteTint: Rgb;
  readonly pressedWhiteTintAlpha: number;
  readonly pressGlow: Rgb;
  readonly travelWhite: number;
  readonly travelBlack: number;
}

export interface PianoSkinNotes {
  readonly low: Rgb;
  readonly mid: Rgb;
  readonly high: Rgb;
  readonly tip: Rgb;
}

export interface PianoSkinAtmosphere {
  readonly moon: Rgb;
  readonly water: readonly [string, string];
  /** Beach foreground: wet-sand near the waterline to dry sand at the base. */
  readonly sand: readonly [string, string];
  /** Floating music-glyph ambience above the instrument. */
  readonly notes: boolean;
  /** Falling-note comets pass in front of the instrument instead of behind it. */
  readonly cometsFront: boolean;
  readonly waterline: Rgb;
  readonly mist: boolean;
  readonly meteors: boolean;
  readonly grain: boolean;
  readonly reflection: boolean;
}

export interface PianoSkin {
  readonly id: PianoSkinId;
  readonly label: string;
  readonly description: string;
  /** Whether the key plane should use the restrained one-point perspective. */
  readonly keyboardPerspective: boolean;
  readonly backdrop: PianoSkinBackdrop;
  readonly case: PianoSkinCase;
  readonly grand: PianoSkinGrand;
  readonly keys: PianoSkinKeys;
  readonly notes: PianoSkinNotes;
  readonly atmosphere: PianoSkinAtmosphere;
}

/** Reference 1: black concert grand, open lid, warm gold interior and trim. */
const LACQUER_GOLD: PianoSkin = {
  id: 'lacquer-gold',
  label: '曜黑鎏金 · Lacquer Gold',
  description: 'Black high-gloss concert grand with a raised lid and gold hardware.',
  keyboardPerspective: true,
  backdrop: {
    top: 'rgba(5,5,6,0.52)',
    mid: 'rgba(9,9,11,0.5)',
    bottom: 'rgba(13,12,11,0.52)',
    horizon: [238, 180, 82],
    horizonAlpha: 0.14,
    vignette: 0.46,
  },
  case: {
    lidTop: '#1c2024',
    lidMid: '#0a0c0e',
    lidBottom: '#030405',
    edge: 'rgba(240,228,196,0.55)',
    inlay: 'rgba(214,162,60,0.8)',
    feltStrip: '#8c1f28',
    fallboardTop: '#17191d',
    fallboardBottom: '#050607',
    fallboardSheen: 'rgba(255,255,255,0.18)',
    keybedTop: '#241b12',
    keybedBottom: '#0a0807',
    keybedShadow: 'rgba(0,0,0,0.30)',
    railTop: '#191c1f',
    railBottom: '#040506',
    engraving: ['#fff7d6', '#e6b94f', '#7a4d16'],
    wood: false,
  },
  grand: {
    shell: '#060708',
    shellDeep: '#010203',
    shellHighlight: '#5a6169',
    interior: '#8a5818',
    trim: '#e2b75f',
    hardware: '#ffeec2',
    lid: '#0a0c0f',
    lidInner: '#2a1a0c',
    lidEdge: '#f6dc92',
    prop: '#181b1f',
    stand: '#07090b',
    leg: '#0e1013',
    pedal: '#dcb056',
    bench: '#07090b',
    benchTop: '#212428',
    line: 'rgba(255,243,200,0.52)',
    lineStrong: 'rgba(255,218,128,0.95)',
    transparent: false,
    glowAlpha: 0.2,
  },
  keys: {
    whiteTop: '#fffef9',
    whiteMid: '#f8f1e0',
    whiteBottom: '#cdc1a6',
    whiteShade: [42, 31, 20],
    blackTop: '#30343a',
    blackBody: '#08090a',
    blackBottom: '#010102',
    blackTip: 'rgba(255,247,219,0.44)',
    pressedWhiteTint: [222, 165, 66],
    pressedWhiteTintAlpha: 0.2,
    pressGlow: [255, 198, 74],
    travelWhite: 3.6,
    travelBlack: 4.2,
  },
  notes: {
    low: [244, 158, 54],
    mid: [255, 206, 110],
    high: [255, 243, 200],
    tip: [255, 252, 232],
  },
  atmosphere: {
    moon: [236, 208, 156],
    water: ['rgba(13,12,11,0)', 'rgba(13,12,11,0)'],
    sand: ['rgba(13,12,11,0)', 'rgba(13,12,11,0)'],
    notes: false,
    cometsFront: true,
    waterline: [255, 226, 160],
    mist: true,
    meteors: false,
    grain: true,
    reflection: true,
  },
};

/** Reference 2: a pearl-white sakura grand over a soft blossom sky. */
const SEASIDE_GLASS: PianoSkin = {
  id: 'seaside-glass',
  label: '樱花珍珠 · Sakura Pearl',
  description: 'A smooth pearl-white grand with rose-gold details beneath a soft sakura sky.',
  keyboardPerspective: true,
  backdrop: {
    top: 'rgba(255,238,242,0.72)',
    mid: 'rgba(255,196,214,0.7)',
    bottom: 'rgba(244,172,196,0.74)',
    horizon: [255, 224, 232],
    horizonAlpha: 0.5,
    vignette: 0.12,
  },
  case: {
    lidTop: '#fffefd',
    lidMid: '#fff8f6',
    lidBottom: '#e9cdd1',
    edge: 'rgba(255,255,255,0.96)',
    inlay: '#d69aa7',
    feltStrip: '#a95b70',
    fallboardTop: '#fffaf8',
    fallboardBottom: '#e8cfd1',
    fallboardSheen: 'rgba(255,255,255,0.76)',
    keybedTop: '#f7e8e5',
    keybedBottom: '#cba3aa',
    keybedShadow: 'rgba(128,76,89,0.16)',
    railTop: '#fae9e6',
    railBottom: '#d9b5ba',
    engraving: ['#e08aa0', '#b65e78', '#6e2c42'],
    wood: false,
  },
  grand: {
    shell: '#fff9f7',
    shellDeep: '#d4aeb5',
    shellHighlight: '#ffffff',
    interior: '#f4d3d3',
    trim: '#d19aa4',
    hardware: '#fff6ef',
    lid: '#fffdfb',
    lidInner: '#f5e1e0',
    lidEdge: '#ffffff',
    prop: '#e0bfc2',
    stand: '#f3dfe0',
    leg: '#ecd0d2',
    pedal: '#c9969f',
    bench: '#e5c4c6',
    benchTop: '#fff2ed',
    line: 'rgba(255,255,255,0.88)',
    lineStrong: 'rgba(199,130,145,0.96)',
    transparent: false,
    glowAlpha: 0.24,
  },
  keys: {
    whiteTop: '#fffefd',
    whiteMid: '#fff8f4',
    whiteBottom: '#e5d0d0',
    whiteShade: [168, 114, 128],
    blackTop: '#645258',
    blackBody: '#2a2326',
    blackBottom: '#171214',
    blackTip: 'rgba(255,244,236,0.62)',
    pressedWhiteTint: [243, 154, 177],
    pressedWhiteTintAlpha: 0.22,
    pressGlow: [255, 150, 181],
    travelWhite: 2.8,
    travelBlack: 3.4,
  },
  notes: {
    low: [211, 106, 132],
    mid: [235, 132, 163],
    high: [249, 172, 190],
    tip: [255, 240, 243],
  },
  atmosphere: {
    moon: [255, 217, 228],
    // Layered translucency: the sky keeps the most body, the sea lightens,
    // and the shore stays the clearest so chat remains readable below.
    water: ['rgba(247,184,204,0)', 'rgba(247,184,204,0)'],
    sand: ['rgba(247,184,204,0)', 'rgba(247,184,204,0)'],
    notes: true,
    cometsFront: false,
    waterline: [246, 157, 183],
    mist: true,
    meteors: false,
    grain: false,
    reflection: true,
  },
};

export const PIANO_SKINS: Readonly<Record<PianoSkinId, PianoSkin>> = Object.freeze({
  'lacquer-gold': LACQUER_GOLD,
  'seaside-glass': SEASIDE_GLASS,
});

/** Only these two family ids are presented in the settings picker. */
export const PIANO_SKIN_IDS: readonly PianoSkinId[] = Object.freeze(
  ['lacquer-gold', 'seaside-glass'] as PianoSkinId[],
);

export const PIANO_SKIN_COMPAT_IDS: readonly PianoSkinCompatId[] = Object.freeze(
  ['porcelain', 'celadon', 'moonlit', 'dawn'] as PianoSkinCompatId[],
);

/** Canonical family ids used by new settings and the picker. */
export const PIANO_SKIN_FAMILY_IDS: readonly PianoSkinId[] = PIANO_SKIN_IDS;

const DEFAULT_SKIN: PianoSkinId = 'seaside-glass';

function isPianoSkinId(value: string): value is PianoSkinId {
  return Object.prototype.hasOwnProperty.call(PIANO_SKINS, value);
}

function canonicalSkinId(value: string): PianoSkinId | undefined {
  if (isPianoSkinId(value)) return value;
  if (value === 'porcelain' || value === 'celadon') return 'lacquer-gold';
  if (value === 'moonlit' || value === 'dawn') return 'seaside-glass';
  return undefined;
}

/** Map any registered or legacy id to its canonical family; undefined if unknown. */
export function canonicalPianoSkinId(value: string): PianoSkinId | undefined {
  return canonicalSkinId(value);
}

/** Resolve unknown ids without throwing; every family serves both presentations. */
export function resolvePianoSkin(id: string | undefined): PianoSkin {
  const canonical = id === undefined ? undefined : canonicalSkinId(id);
  return PIANO_SKINS[canonical ?? DEFAULT_SKIN];
}
