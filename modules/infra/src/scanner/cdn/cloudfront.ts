import { logger as rootLogger } from '@sentinel/shared/logger';
const log = rootLogger.child({ component: 'cdn-cloudfront' });

export async function validateCredentials(_accessKeyId: string, _secretAccessKey: string, _region: string): Promise<{ valid: boolean; message: string }> {
  log.warn('CloudFront SDK not installed. Add @aws-sdk/client-cloudfront to modules/infra/package.json');
  return { valid: false, message: 'CloudFront integration requires @aws-sdk/client-cloudfront to be installed' };
}

export async function getOriginDomains(_accessKeyId: string, _secretAccessKey: string, _region: string, _domain: string): Promise<string[]> {
  return [];
}
