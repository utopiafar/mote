import { validateServerUrl } from './config';
import { formatEvidenceRef, parseEvidenceRef } from '@mote/shared';

/** The browser owns its login session. Never include the collector token in a URL. */
export async function openCentralBrowser(serverUrl: string, page: string | undefined, platform: string,
  launchChrome: (url: string) => Promise<unknown>, openDefault: (url: string) => Promise<unknown>, evidenceId?: string): Promise<void> {
  const origin = validateServerUrl(serverUrl);
  let hash = ['ask', 'notes', 'vault'].includes(page ?? '') ? '#' + page : '';
  if (evidenceId !== undefined) {
    if (typeof evidenceId !== 'string' || !evidenceId.trim() || evidenceId.length > 4096 || /[\u0000-\u001f\u007f]/.test(evidenceId)) throw new Error('Invalid evidence reference');
    const parsed = parseEvidenceRef(evidenceId);
    const reference = parsed ? formatEvidenceRef(parsed.kind, parsed.id) : evidenceId;
    // Keep opaque/versioned references intact; the central reader checks current access.
    // The reference is query data, never a destination URL or credential.
    hash = '#/ask?' + new URLSearchParams({ evidence: reference });
  }
  const url = origin + '/' + hash;
  if (platform === 'darwin') {
    try { await launchChrome(url); return; } catch { /* Chrome may not be installed. */ }
  }
  await openDefault(url);
}
