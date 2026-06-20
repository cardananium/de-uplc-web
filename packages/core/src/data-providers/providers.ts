import { DataProvider } from './data-provider.interface';
import { KoiosClient } from './koios-client';
import { FileProvider } from './file-provider';
import { ProviderResolver, RefScriptResolver, SettingsStore } from '../ports';
import { Network } from '../common';

/**
 * Builds data providers from the current settings on demand. Replaces the original
 * vscode-config-bound `providers.ts` (no `getConfiguration`, no `workspaceFolders`,
 * no `onDidChangeConfiguration` — settings are read fresh each call from the SettingsStore,
 * so updates take effect immediately).
 *
 * Endpoint selection: an explicit `customEndpoint` always wins; otherwise Koios is called
 * DIRECTLY at `KOIOS_ENDPOINTS[network]`. With an API key it travels in the `Authorization`
 * header (note: a client-side key is visible in the browser — fine for personal use, a leak
 * for a shared deploy).
 */
export function createProviderResolver(
  settings: SettingsStore,
  refScriptResolver?: RefScriptResolver,
): ProviderResolver {
  return {
    getOnline(customEndpoint?: string, _network?: Network): DataProvider {
      const s = settings.getProviderSettings();
      // No custom endpoint → KoiosClient falls back to KOIOS_ENDPOINTS[network] (direct).
      const endpoint = customEndpoint;
      return new KoiosClient({
        apiKey: s.apiKey,
        timeout: s.timeout,
        retryAttempts: s.retryAttempts,
        customEndpoint: endpoint,
        refScriptResolver,
      });
    },
    getOffline(): DataProvider {
      const s = settings.getProviderSettings();
      return new FileProvider({
        data: settings.getOfflineData(),
        enabled: s.offlineEnabled,
      });
    },
  };
}
