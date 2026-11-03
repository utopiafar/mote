/** Generated seed for the external plugin development flow.
 *
 * `plugin-dev dev --seed` exports MOTE_URL/MOTE_TOKEN for this owner-only
 * process. It creates one generated card, selects a strategy when none is set
 * and performs one review round. It never reads a vault or a personal profile. */
import {PLUGIN_SDK_VERSION} from '@mote/plugin-sdk';

const base = process.env.MOTE_URL;
const token = process.env.MOTE_TOKEN;
if (!base || !token) throw Error('seed requires MOTE_URL and MOTE_TOKEN from plugin-dev');

async function request(path, method = 'GET', payload) {
  const response = await fetch(base + path, {
    method,
    headers: {Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : {'Content-Type': 'application/json'})},
    ...(payload === undefined ? {} : {body: JSON.stringify(payload)}),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(`reading review ${method} ${path} failed with HTTP ${response.status}`);
  return value;
}

const endpoint = '/api/connectors/reading-review';
let state = await request(`${endpoint}/state`);
if (!state.strategy) state = await request(`${endpoint}/strategy`, 'PUT', {strategy: 'spaced'});
let card = state.cards[0];
if (!card) {
  state = await request(`${endpoint}/cards`, 'POST', {
    prompt: 'Generated reading prompt',
    answer: `Generated reading answer from the external package (SDK ${PLUGIN_SDK_VERSION})`,
  });
  card = state.cards[0];
}
const reviewed = await request(`${endpoint}/round`, 'POST', {cardId: card.id, rating: 'good'});
console.log(JSON.stringify({
  sdkVersion: PLUGIN_SDK_VERSION,
  strategy: reviewed.strategy,
  cardId: card.id,
  reviews: reviewed.historyCount,
  dueCardIds: reviewed.dueCardIds,
  stateRevision: reviewed.stateRevision,
}));
