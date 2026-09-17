import { validateServerUrl } from './config';

/** The browser owns its login session. Never include the collector token in a URL. */
export async function openCentralBrowser(serverUrl: string, page: string | undefined, platform: string,
  launchChrome: (url: string) => Promise<unknown>, openDefault: (url: string) => Promise<unknown>): Promise<void> {
  const origin = validateServerUrl(serverUrl);
  const url = origin + '/' + (['ask', 'notes', 'vault'].includes(page ?? '') ? '#' + page : '');
  if (platform === 'darwin') {
    try { await launchChrome(url); return; } catch { /* Chrome may not be installed. */ }
  }
  await openDefault(url);
}
