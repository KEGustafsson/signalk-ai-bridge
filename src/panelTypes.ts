import type { EmbeddedWebAppApi } from './types.js';

export interface AppPanelProps extends EmbeddedWebAppApi {
  readonly serverId?: string;
  readonly bridgeFetch?: typeof fetch;
  readonly bridgeEndpoint?: string;
}
