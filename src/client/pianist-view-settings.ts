import { registerDshPianoView } from '../plugin/view.js';
import type { PianoSamplePack } from '../audio/sample-pack.js';
import type { PianistSettings } from '../shared/pianist-settings.js';

interface PianistSettingsTarget extends Element {
  setPianistSettings?(settings: PianistSettings): unknown;
  setSamplePack?(samplePack: PianoSamplePack | null): unknown;
}

function sameSettings(left: PianistSettings | undefined, right: PianistSettings): boolean {
  return left !== undefined
    && left.enabled === right.enabled
    && left.renderMode === right.renderMode
    && left.skin === right.skin
    && left.returnToEmbeddedOnEnd === right.returnToEmbeddedOnEnd
    && left.visualQuality === right.visualQuality
    && left.volume === right.volume
    && left.showWaterfall === right.showWaterfall
    && left.events.notes === right.events.notes
    && left.events.pedal === right.events.pedal
    && left.events.tempo === right.events.tempo
    && left.events.particles === right.events.particles;
}

function copySettings(settings: PianistSettings): PianistSettings {
  return structuredClone(settings);
}

/**
 * Bridges committed profile settings to browser views. It never reads or
 * writes local storage: the caller controls when a Host-RPC result is safe to
 * publish, and this class only fans that result out to DOM instances.
 */
export class PianistViewSettingsBridge {
  private settings: PianistSettings | undefined;
  private observer: MutationObserver | undefined;

  constructor(
    private readonly root: Document = document,
    private samplePack: PianoSamplePack | null = null,
  ) {}

  start(): void {
    registerDshPianoView();
    this.applyAll();
    if (typeof MutationObserver === 'undefined') return;
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) this.applyTree(node);
      }
    });
    this.observer.observe(this.root.documentElement, { childList: true, subtree: true });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  /** Publish a Host-accepted value to current views and remember it for later mounts. */
  setCommittedSettings(settings: PianistSettings): void {
    if (sameSettings(this.settings, settings)) return;
    this.settings = copySettings(settings);
    this.applyAll();
  }

  /** Publish a pack to current views and remember it for later mounts. */
  setSamplePack(samplePack: PianoSamplePack | null): void {
    if (this.samplePack === samplePack) return;
    this.samplePack = samplePack;
    this.applyAll();
  }

  private applyAll(): void {
    for (const element of this.root.querySelectorAll('dsh-piano-view')) this.apply(element);
  }

  private applyTree(node: Node): void {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.matches('dsh-piano-view')) this.apply(element);
    for (const child of element.querySelectorAll('dsh-piano-view')) this.apply(child);
  }

  private apply(element: Element): void {
    const target = element as PianistSettingsTarget;
    target.setSamplePack?.(this.samplePack);
    if (this.settings !== undefined) target.setPianistSettings?.(copySettings(this.settings));
  }
}
