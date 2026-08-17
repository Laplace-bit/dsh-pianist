import { useState, type CSSProperties } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client';
import { IconChevronDownOutline14, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PianistEventSettings, PianistRenderMode, VisualQuality } from '../plugin/config.js';
import type { PianistCardFace, PianistCardState } from './pianist-card-controller.js';
import type { PianistLocaleKey } from './locales.js';
import { PianistSkinPicker } from './PianistSkinPicker.js';

export type PianistSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.pianist'>
  & InjectFace<PianistCardFace>;

const cardStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-fg-base)',
  borderRadius: 12,
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  alignItems: 'center',
  background: 'var(--dsw-alias-bg-layer-3)',
  border: 0,
  borderRadius: 12,
  color: 'inherit',
  cursor: 'pointer',
  display: 'flex',
  gap: 10,
  padding: '12px 14px',
  textAlign: 'left',
  width: '100%',
};

const bodyStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  display: 'grid',
  gap: 14,
  padding: 14,
};

const fieldStyle: CSSProperties = { display: 'grid', gap: 6, minWidth: 0 };
const hintStyle: CSSProperties = { color: 'var(--dsw-alias-fg-muted)', fontSize: 12, lineHeight: 1.45 };
const labelStyle: CSSProperties = { fontSize: 13, fontWeight: 600 };
const controlStyle: CSSProperties = { maxWidth: '100%' };

const EVENT_LABELS: Record<keyof PianistEventSettings, PianistLocaleKey> = {
  notes: 'eventNotes',
  pedal: 'eventPedal',
  tempo: 'eventTempo',
  particles: 'eventParticles',
};

const QUALITY_LABELS: Record<VisualQuality, PianistLocaleKey> = {
  low: 'qualityLow',
  medium: 'qualityMedium',
  high: 'qualityHigh',
};

const RENDER_MODE_LABELS: Record<PianistRenderMode, PianistLocaleKey> = {
  immersive: 'renderModeImmersive',
  embedded: 'renderModeEmbedded',
};

/** Theme-token based settings card that remains visible while the RPC is unavailable. */
export function PianistSettingsCard(props: PianistSettingsCardProps) {
  const { t } = props;
  const [open, setOpen] = useState(false);
  const state = props.usePianistSettingsCard(snapshot => snapshot) as PianistCardState;
  const settings = state.settings;
  const disabled = !state.writable || state.saving || state.status !== 'ready';
  const blocked = !state.dirty || disabled;
  const volume = Math.round(settings.volume * 100);
  const versionLabel = state.version === undefined
    ? undefined
    : t(state.installation === 'development' ? 'developmentVersion' : 'version').replace('{version}', state.version);

  return (
    <li style={cardStyle} data-plugin="dsh-pianist">
      <button type="button" style={headerStyle} aria-expanded={open} onClick={() => { setOpen(!open); }}>
        <span style={{ display: 'grid', flex: 1, gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 650 }}>{t('title')}</span>
          <span style={hintStyle}>{t('description')}</span>
        </span>
        {versionLabel === undefined ? null : <span style={hintStyle}>{versionLabel}</span>}
        {state.dirty ? <span style={{ fontSize: 12, fontWeight: 600 }}>{t('unsaved')}</span> : null}
        <span aria-hidden="true" style={{ display: 'inline-flex', flex: '0 0 auto', transform: open ? 'rotate(180deg)' : undefined }}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {!open ? null : (
        <div style={bodyStyle}>
          {state.status === 'loading' ? <p role="status" style={hintStyle}>{t('loading')}</p> : null}
          {state.status === 'unavailable' ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
              <p role="status" style={{ ...hintStyle, margin: 0 }}>{t('unavailable')}</p>
              <button type="button" onClick={props.reload}>{t('retry')}</button>
            </div>
          ) : null}
          {state.status !== 'ready' ? null : (
            <>
              {!state.writable ? <p role="status" style={{ ...hintStyle, margin: 0 }}>{t('readOnly')}</p> : null}
              <label style={fieldStyle}>
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <span style={labelStyle}>{t('enabled')}</span>
                  <input
                    type="checkbox"
                    checked={settings.enabled}
                    disabled={disabled}
                    aria-label={t('enabled')}
                    onChange={(event) => { props.edit({ enabled: event.target.checked }); }}
                  />
                </span>
                <span style={hintStyle}>{t('enabledHint')}</span>
              </label>
              <label style={fieldStyle}>
                <span style={labelStyle}>{t('renderMode')}</span>
                <div
                  role="radiogroup"
                  aria-label={t('renderMode')}
                  style={{ display: 'grid', gap: 4 }}
                >
                  {(['immersive', 'embedded'] as const).map(mode => (
                    <label key={mode} style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
                      <input
                        type="radio"
                        name="dsh-pianist-render-mode"
                        value={mode}
                        checked={settings.renderMode === mode}
                        disabled={disabled}
                        onChange={() => { props.edit({ renderMode: mode }); }}
                      />
                      <span>{t(RENDER_MODE_LABELS[mode])}</span>
                    </label>
                  ))}
                </div>
              </label>
              <section style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', display: 'grid', gap: 14, paddingTop: 12 }}>
                <PianistSkinPicker
                  value={settings.skin}
                  disabled={disabled}
                  label={t('skin')}
                  previewLabel={t('skinPreview')}
                  onChange={(id) => { props.edit({ skin: id }); }}
                />
              </section>
              <label style={fieldStyle}>
                <span style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={labelStyle}>{t('returnToEmbeddedOnEnd')}</span>
                  <input
                    type="checkbox"
                    checked={settings.returnToEmbeddedOnEnd}
                    disabled={disabled}
                    aria-label={t('returnToEmbeddedOnEnd')}
                    onChange={(event) => { props.edit({ returnToEmbeddedOnEnd: event.target.checked }); }}
                  />
                </span>
              </label>
              <label style={fieldStyle}>
                <span style={labelStyle}>{t('visualQuality')}</span>
                <select
                  value={settings.visualQuality}
                  disabled={disabled}
                  style={controlStyle}
                  aria-label={t('visualQuality')}
                  onChange={(event) => { props.edit({ visualQuality: event.target.value as VisualQuality }); }}
                >
                  {(['low', 'medium', 'high'] as const).map(value => <option key={value} value={value}>{t(QUALITY_LABELS[value])}</option>)}
                </select>
              </label>
              <label style={fieldStyle}>
                <span style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={labelStyle}>{t('volume')}</span>
                  <output>{volume}%</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={volume}
                  disabled={disabled}
                  aria-label={t('volume')}
                  onChange={(event) => { props.edit({ volume: Number(event.target.value) / 100 }); }}
                />
              </label>
              <label style={{ alignItems: 'center', display: 'flex', gap: 7 }}>
                <input type="checkbox" checked={settings.showWaterfall} disabled={disabled} onChange={(event) => {
                  props.edit({ showWaterfall: event.target.checked });
                }} />
                {t('showWaterfall')}
              </label>
              <section style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', display: 'grid', gap: 8, paddingTop: 12 }} aria-labelledby="dsh-pianist-events">
                <span id="dsh-pianist-events" style={labelStyle}>{t('events')}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px' }}>
                  {(Object.keys(EVENT_LABELS) as Array<keyof PianistEventSettings>).map(event => (
                    <label key={event} style={{ alignItems: 'center', display: 'flex', gap: 7 }}>
                      <input type="checkbox" checked={settings.events[event]} disabled={disabled} onChange={(change) => {
                        props.edit({ events: { [event]: change.target.checked } });
                      }} />
                      {t(EVENT_LABELS[event])}
                    </label>
                  ))}
                </div>
              </section>
              <section style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', display: 'grid', gap: 8, paddingTop: 12 }} aria-label={t('updates')}>
                <span style={labelStyle}>{t('updates')}</span>
                <span role="status" style={hintStyle}>
                  {state.repairRequired ? t('repairRequired')
                    : state.restartRequired ? t('restartRequired')
                      : state.installation === 'registry' && state.canUpgrade ? t('updateHint')
                        : state.installation === 'development' ? t('developmentBuild') : t('updateUnavailable')}
                </span>
                <div>
                  <button
                    type="button"
                    disabled={!state.canUpgrade || state.upgrading || state.restartRequired}
                    title={state.canUpgrade ? undefined : t('updateUnavailable')}
                    onClick={props.upgrade}
                  >
                    <span aria-hidden="true"><IconRefreshOutline14 /></span>{' '}
                    {t(state.upgrading ? 'updating' : 'update')}
                  </button>
                </div>
                {state.upgradeFailed ? <p role="status" style={{ ...hintStyle, margin: 0 }}>{t('updateFailed')}</p> : null}
              </section>
              {state.failed ? <p role="status" style={{ ...hintStyle, margin: 0 }}>{t('saveFailed')}</p> : null}
              {state.saved ? <p role="status" style={{ ...hintStyle, margin: 0 }}>{t('saved')}</p> : null}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" disabled={!state.dirty || state.saving} onClick={props.discard}>{t('discard')}</button>
                <button type="button" disabled={blocked} onClick={props.save}>{t(state.saving ? 'saving' : 'save')}</button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}
