/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PianistSettingsCard } from '../src/client/PianistSettingsCard.js';
import type { PianistCardFace, PianistCardState } from '../src/client/pianist-card-controller.js';
import { DEFAULT_PIANIST_SETTINGS } from '../src/shared/pianist-settings.js';
import type { PianistLocaleKey } from '../src/client/locales.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
  IconRefreshOutline14: () => null,
}));

const t = (key: PianistLocaleKey): string => key === 'developmentVersion'
  ? 'developmentVersion {version}'
  : key;

function state(overrides: Partial<PianistCardState> = {}): PianistCardState {
  return {
    status: 'ready',
    writable: true,
    dirty: false,
    saving: false,
    saved: false,
    failed: false,
    settings: structuredClone(DEFAULT_PIANIST_SETTINGS),
    version: '0.1.0',
    installation: 'development',
    canUpgrade: false,
    upgrading: false,
    upgradeFailed: false,
    restartRequired: false,
    repairRequired: false,
    ...overrides,
  };
}

const mounted = new Set<ReturnType<typeof createRoot>>();

afterEach(() => {
  for (const root of mounted) {
    act(() => { root.unmount(); });
  }
  mounted.clear();
  document.body.replaceChildren();
});

function renderCard(current: PianistCardState, face: Partial<PianistCardFace> = {}) {
  const props = {
    t,
    usePianistSettingsCard: <T,>(selector: (snapshot: PianistCardState) => T) => selector(current),
    edit: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    reload: vi.fn(),
    upgrade: vi.fn(),
    ...face,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.add(root);
  act(() => { root.render(createElement(PianistSettingsCard, props as never)); });
  return { props, container };
}

function button(container: Element, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find(candidate =>
    candidate.textContent?.trim() === label,
  );
  if (match === undefined) throw new Error(`Button ${label} was not rendered`);
  return match;
}

function cardHeader(container: Element): HTMLButtonElement {
  const header = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
  if (header === null) throw new Error('Card header was not rendered');
  return header;
}

function control<T extends HTMLElement>(container: Element, label: string, selector: string): T {
  const field = [...container.querySelectorAll('label')].find(candidate => candidate.textContent?.includes(label));
  const match = field?.querySelector<T>(selector);
  if (match === null || match === undefined) throw new Error(`Control ${label} was not rendered`);
  return match;
}

function change(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = input instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter === undefined) throw new Error('Control has no native value setter');
  setter.call(input, value);
  act(() => {
    if (input.type === 'range') {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('PianistSettingsCard', () => {
  it('stages editable profile settings without an audio-source selector', () => {
    const { props, container } = renderCard(state());

    act(() => { cardHeader(container).click(); });
    const enabled = control<HTMLInputElement>(container, 'enabled', 'input[type="checkbox"]');
    expect(enabled.checked).toBe(true);
    expect(button(container, 'save').disabled).toBe(true);

    act(() => { enabled.click(); });
    const quality = control<HTMLSelectElement>(container, 'visualQuality', 'select');
    change(quality, 'high');
    const volume = control<HTMLInputElement>(container, 'volume', 'input[type="range"]');
    change(volume, '45');

    expect(props.edit).toHaveBeenNthCalledWith(1, { enabled: false });
    expect(props.edit).toHaveBeenNthCalledWith(2, { visualQuality: 'high' });
    expect(props.edit).toHaveBeenNthCalledWith(3, { volume: 0.45 });
    expect(button(container, 'update').disabled).toBe(true);

    // The sound is fixed to the sample pack; no selector is rendered.
    expect(container.querySelector('select[aria-label="audioSource"]')).toBeNull();
    expect(container.textContent).not.toContain('audioSourceHint');
    expect(container.textContent).not.toContain('samplePackUnavailable');
  });

  it('does not render a show-keyboard toggle', () => {
    const { container } = renderCard(state());

    act(() => { cardHeader(container).click(); });
    const keyboard = [...container.querySelectorAll('input[type="checkbox"]')]
      .find(candidate => candidate.getAttribute('aria-label') === 'showKeyboard'
        || candidate.closest('label')?.textContent?.includes('showKeyboard'));
    expect(keyboard).toBeUndefined();
  });

  it('renders an actionable retry state instead of disappearing when plugin RPC is unavailable', () => {
    const { props, container } = renderCard(state({ status: 'unavailable', writable: false, version: undefined }));

    act(() => { cardHeader(container).click(); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('unavailable');
    act(() => { button(container, 'retry').click(); });
    expect(props.reload).toHaveBeenCalledTimes(1);
  });

  it('enables save only for a writable dirty form and invokes the staged commands', () => {
    const { props, container } = renderCard(state({ dirty: true }));

    act(() => { cardHeader(container).click(); });
    act(() => { button(container, 'discard').click(); });
    act(() => { button(container, 'save').click(); });

    expect(props.discard).toHaveBeenCalledTimes(1);
    expect(props.save).toHaveBeenCalledTimes(1);
  });

  it('toggles the immersive/embedded render mode and the return-to-chat flag', () => {
    const { props, container } = renderCard(state());

    act(() => { cardHeader(container).click(); });
    const immersive = container.querySelector<HTMLInputElement>('input[type="radio"][value="immersive"]');
    const embedded = container.querySelector<HTMLInputElement>('input[type="radio"][value="embedded"]');
    if (immersive === null || embedded === null) throw new Error('render mode radios missing');
    expect(immersive.checked).toBe(true);

    act(() => { embedded.click(); });
    expect(props.edit).toHaveBeenCalledWith({ renderMode: 'embedded' });

    const returnFlag = container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="returnToEmbeddedOnEnd"]');
    if (returnFlag === null) throw new Error('return-to-embedded checkbox missing');
    act(() => { returnFlag.click(); });
    expect(props.edit).toHaveBeenCalledWith({ returnToEmbeddedOnEnd: false });
  });

  it('shows a single shared skin picker and stages a selection', () => {
    const { props, container } = renderCard(state());

    act(() => { cardHeader(container).click(); });
    const choices = [...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')];
    expect(choices).toHaveLength(2);

    act(() => { choices[1]?.click(); });
    expect(props.edit).toHaveBeenCalledWith({ skin: 'seaside-glass' });
  });
});
