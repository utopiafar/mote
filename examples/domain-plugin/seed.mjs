import {PLUGIN_SDK_VERSION} from '@mote/plugin-sdk';

/** Generated-seed hook for `plugin-dev dev --seed`: writes one generated item
 * through the owner routes, checks the mapped error branch, and prints a JSON
 * observation. No personal data. */
const base = process.env.MOTE_URL;
const token = process.env.MOTE_TOKEN;
if (!base || !token) throw Error('seed requires MOTE_URL and MOTE_TOKEN from plugin-dev');

const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {...init, headers});
  if (!response.ok) throw Error(`${init.method ?? 'GET'} ${path}: ${response.status}`);
  return response.json();
}

const before = await request('/api/connectors/template-collection/state');
const item = await request('/api/connectors/template-collection/items', {
  method: 'POST',
  body: JSON.stringify({text: `Generated collection item; SDK ${PLUGIN_SDK_VERSION}`}),
});
// Error branch: invalid input must fail through the real mount. The current
// connector mount maps plugin failures to its generic operation error —
// domain codes ride along in the dispatcher-mapped shape for hosts that
// resolve them.
const refused = await fetch(`${base}/api/connectors/template-collection/items`, {
  method: 'POST',
  headers,
  body: JSON.stringify({text: ''}),
});
if (refused.status !== 502) throw Error(`Invalid item returned HTTP ${refused.status}, expected the host's generic failure mapping`);
const refusedBody = await refused.json();
if (refusedBody.error !== 'connector_operation_failed') throw Error(`Invalid item returned ${refusedBody.error}, expected connector_operation_failed`);
const after = await request('/api/connectors/template-collection/state');
console.log(JSON.stringify({
  sdkVersion: PLUGIN_SDK_VERSION,
  itemId: item.id,
  itemsBefore: before.items.length,
  itemsAfter: after.items.length,
  refusedStatus: refused.status,
  refused: refusedBody.error,
}));
