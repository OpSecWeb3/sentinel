export interface ProxyCheckResult {
  hostId: string;
  hostname: string;
  isProxied: boolean;
  provider: string | null;
  detectionMethod: string | null;
  hasProviderConfig: boolean;
}
