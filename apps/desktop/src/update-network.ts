import { checkRelease, downloadReleaseAsset } from '@mote/shared/release';

/** Update-only transport. The shared verifier still controls hosts, redirects and integrity. */
export function createUpdateNetwork(fetcher: typeof fetch): { check: typeof checkRelease; download: typeof downloadReleaseAsset } {
  const publicFetch: typeof fetch = (input, init) => fetcher(input, { ...init, credentials: 'omit', redirect: 'manual' });
  return {
    check: options => checkRelease({ ...options, fetch: publicFetch }),
    download: (asset, destination, options) => downloadReleaseAsset(asset, destination, { ...options, fetch: publicFetch }),
  };
}
