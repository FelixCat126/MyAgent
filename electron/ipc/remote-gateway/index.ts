import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';

import {
  loadOrCreateConfig,
  mergeRemoteGatewayPatch,
  persistConfig,
  type RemoteGatewayFileConfig,
} from './config';
import { applyRemoteGatewayListening, setMainWindowGetter } from './router';

export function attachRemoteGatewayMainWindow(getter: () => BrowserWindow | null): void {
  setMainWindowGetter(getter);
}

let ipcRegistered = false;

export async function bootstrapRemoteGatewayFromDisk(): Promise<void> {
  if (!ipcRegistered) {
    ipcRegistered = true;
    ipcMain.removeHandler('remote-gateway-get-config');
    ipcMain.handle('remote-gateway-get-config', async () => await loadOrCreateConfig());
    ipcMain.removeHandler('remote-gateway-set-config');
    ipcMain.handle(
      'remote-gateway-set-config',
      async (
        _e,
        patch: Partial<
          Pick<RemoteGatewayFileConfig, 'enabled' | 'port' | 'token'> & { regenerateToken?: boolean }
        >
      ) => {
        const cfg = await loadOrCreateConfig();
        const next = mergeRemoteGatewayPatch(cfg, patch ?? {});
        await persistConfig(next);
        await applyRemoteGatewayListening(next);
        return next;
      }
    );
  }
  const cfg = await loadOrCreateConfig();
  await applyRemoteGatewayListening(cfg);
}