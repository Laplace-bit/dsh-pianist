import type { CSSProperties } from 'react';
import {
  PIANO_SKIN_IDS,
  PIANO_SKINS,
  type PianoSkin,
  type PianoSkinId,
} from '../visual/skin.js';

interface PianistSkinPickerProps {
  value: PianoSkinId;
  disabled: boolean;
  label: string;
  previewLabel: string;
  onChange: (id: PianoSkinId) => void;
}

const pickerStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
};

const labelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))',
};

const cardStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  cursor: 'pointer',
  display: 'grid',
  gap: 7,
  minHeight: 116,
  padding: 8,
  textAlign: 'left',
  transition: 'border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease',
};

const previewStyle: CSSProperties = {
  alignItems: 'stretch',
  borderRadius: 5,
  display: 'grid',
  minHeight: 72,
  overflow: 'hidden',
  padding: 7,
  position: 'relative',
};

function previewGradient(skin: PianoSkin): string {
  return `linear-gradient(160deg, ${skin.backdrop.top}, ${skin.backdrop.mid} 56%, ${skin.backdrop.bottom})`;
}

function SkinPreview({ skin, selected, label }: { skin: PianoSkin; selected: boolean; label: string }) {
  const line = skin.grand.transparent ? skin.grand.lineStrong : skin.case.edge;
  const fill = skin.grand.transparent ? 'transparent' : skin.grand.shell;
  return (
    <div
      aria-hidden="true"
      style={{
        ...previewStyle,
        background: previewGradient(skin),
        boxShadow: selected ? `inset 0 0 0 1px rgba(${skin.notes.high.join(',')},0.55)` : 'inset 0 0 0 1px rgba(255,255,255,0.08)',
      }}
    >
      <div style={{ position: 'relative', minHeight: 74 }}>
        {/* Minimal grand: a rounded body, a lid accent, and a key strip. */}
        <span style={{
          background: fill,
          border: `1px solid ${line}`,
          borderRadius: '7px 20px 5px 5px',
          bottom: 14,
          height: 34,
          left: '10%',
          position: 'absolute',
          right: '10%',
        }} />
        <span style={{
          background: skin.grand.lid,
          border: `1px solid ${skin.grand.lidEdge}`,
          borderRadius: 3,
          height: 6,
          left: '24%',
          position: 'absolute',
          top: 8,
          transform: 'rotate(-20deg)',
          transformOrigin: 'left center',
          width: '56%',
        }} />
        <span style={{
          background: skin.case.keybedBottom,
          border: `1px solid ${line}`,
          borderRadius: 3,
          bottom: 12,
          height: 12,
          left: '18%',
          position: 'absolute',
          right: '18%',
        }}>
          {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(key => <i key={key} style={{
            background: key % 3 === 0 ? skin.keys.blackBody : skin.keys.whiteMid,
            borderRight: `1px solid ${skin.grand.line}`,
            display: 'inline-block',
            height: '100%',
            width: `${100 / 9}%`,
          }} />)}
        </span>
      </div>
      <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
}

/** Pure presentation control for selecting the single shared skin. */
export function PianistSkinPicker({ value, disabled, label, previewLabel, onChange }: PianistSkinPickerProps) {
  const choices = PIANO_SKIN_IDS;
  return (
    <section style={pickerStyle} aria-label={label}>
      <span style={labelStyle}>{label}</span>
      <div role="radiogroup" aria-label={label} style={gridStyle}>
        {choices.map(id => {
          const skin = PIANO_SKINS[id];
          const selected = value === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${skin.label} ${previewLabel}`}
              disabled={disabled}
              onClick={() => { onChange(id); }}
              style={{
                ...cardStyle,
                background: selected ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
                borderColor: selected ? `rgba(${skin.notes.high.join(',')},0.78)` : 'var(--dsw-alias-border-l2)',
                boxShadow: selected ? `0 0 0 2px rgba(${skin.notes.low.join(',')},0.16)` : 'none',
                opacity: disabled ? 0.58 : 1,
              }}
            >
              <SkinPreview skin={skin} selected={selected} label={skin.label} />
              <span style={{ color: 'var(--dsw-alias-fg-base)', fontSize: 12, fontWeight: selected ? 650 : 500 }}>{skin.label}</span>
              <span style={{ color: 'var(--dsw-alias-fg-muted)', fontSize: 11, lineHeight: 1.35 }}>{skin.description}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
