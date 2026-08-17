/** Browser entry: settings-card registration only; durable state stays in the Host profile. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client';
import type {} from '@deepseek-ai/dsh-client-ui-tool/client';
import { PianistSettingsCard } from './PianistSettingsCard.js';
import { PianoToolView } from './PianoToolView.js';
import { PianistCardController } from './pianist-card-controller.js';
import { createPianoPerformanceApi, createPianistSettingsApi } from './pianist-settings-api.js';
import { PianistViewSettingsBridge } from './pianist-view-settings.js';
import { createBundledSalamanderPianoSamplePack } from '../audio/bundled-sample-pack.js';
import { en, NS, zh } from './locales.js';

/** The card does not wait for an optional runtime service before registering. */
export const inject: string[] = [];

export function apply(ctx: ClientContext): void {
  if (typeof window === 'undefined') return;
  ctx.inject(['slots', 'locale', 'connection'], (settingsCtx) => {
    const connection = settingsCtx.get('connection') as unknown as ConnectionHandle;
    const controller = new PianistCardController(
      createPianistSettingsApi(connection),
    );
    const performances = createPianoPerformanceApi(connection);
    const views = new PianistViewSettingsBridge(document, createBundledSalamanderPianoSamplePack());
    const publishCommittedSettings = (): void => {
      const state = controller.getSnapshot();
      // The card keeps edits staged locally. Browser views receive only a Host
      // read or write result, never values that have not been accepted by the
      // active profile yet.
      if (state.status === 'ready' && !state.dirty) {
        views.setCommittedSettings(state.settings);
      }
    };
    const unsubscribe = controller.subscribe(publishCommittedSettings);
    views.start();
    controller.start();
    settingsCtx.effect(() => settingsCtx.locale.register(NS, { zh, en }), 'dsh-pianist: settings dictionaries');
    settingsCtx.slots.inject('tool.call.toolview', () => settingsCtx.slots.register({
      name: 'tool.call.toolview',
      key: 'piano_perform',
      locale: NS,
      inject: () => ({ readPerformance: performances.read }),
    }, PianoToolView));
    settingsCtx.slots.inject('settings.plugin.item', () => settingsCtx.slots.register({
      name: 'settings.plugin.item',
      id: 'pianist',
      key: 'pianist',
      order: 50,
      locale: NS,
      inject: () => controller.inject(),
    // rc.5 declares this slot as a list (`id`); rc.8 declares it as keyed
    // (`key`). Both runtimes ignore the non-owning discriminator.
    } as never, PianistSettingsCard));
    return () => {
      unsubscribe();
      views.stop();
      controller.stop();
    };
  });
}
