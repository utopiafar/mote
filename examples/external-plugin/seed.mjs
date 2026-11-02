import {PLUGIN_SDK_VERSION} from '@mote/plugin-sdk';

const base = process.env.MOTE_URL, token = process.env.MOTE_TOKEN;
if (!base || !token) throw Error('seed requires MOTE_URL and MOTE_TOKEN from plugin-dev');
async function request(path, method = 'GET', payload) {
  const response = await fetch(base + path, {
    method,
    headers: {Authorization: `Bearer ${token}`, ...(payload ? {'Content-Type': 'application/json'} : {})},
    ...(payload ? {body: JSON.stringify(payload)} : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(`generated ingress ${method} ${path} failed with HTTP ${response.status}`);
  return value;
}
const source = await request('/api/sources', 'POST', {
  id: 'generated-external-source', name: 'Generated external source', kind: 'example.external-source',
  deviceId: 'generated-external-device', platform: 'import',
});
const item = await request(`/api/sources/${source.id}/items`, 'PUT', {
  externalId: 'generated-external-1', revision: '1', observedAt: new Date().toISOString(),
  title: 'Generated external item', kind: 'message', layer: 'original',
  text: `Generated data through existing ingress; SDK ${PLUGIN_SDK_VERSION}`,
});
const listed = await request(`/api/sources/${source.id}/items`);
console.log(JSON.stringify({sourceId: source.id, receipt: item.receipt, itemCount: listed.items?.length ?? null}));
