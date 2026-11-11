# Outbound Webhooks and Developer API

Outbound Webhooks and the Developer API are host surfaces on **AI Access**
(`#/connections/access`). They are not installable official packages. Enabling
them does not install anything, and the plugin catalog only points to this
configuration surface.

## Event stream

Both delivery modes use the same durable host event journal. A successful
material publication appends one event when the publication is not a no-op.
The envelope is deliberately bounded:

```json
{
  "id": "evt_<uuid>",
  "type": "material.archived",
  "version": 1,
  "occurredAt": "2026-11-11T00:00:00.000Z",
  "sourceId": "source-id",
  "material": {
    "id": "mat_<hash>",
    "revision": "<revision>",
    "kind": "mote.note",
    "deviceId": "device-id"
  }
}
```

It never contains material text, titles, member references, capture originals,
screenshots, Coding Agent transcripts or images. Screen/Coding Agent sources and
the host's other sensitive material kinds are filtered before the journal row is
written.

## Webhooks

Create an endpoint under **AI Access → Webhooks and Developer API**. A webhook
has an explicit source-ID list, the `material.archived` event kind, an enabled
flag, a retry budget and an HTTP(S) target. Empty targets, empty scopes and `*`
wildcards are rejected. Pending deliveries are not created while an endpoint is
disabled.

Each request is a signed JSON `POST`:

| Header | Meaning |
| --- | --- |
| `X-Mote-Delivery-Id` | Stable delivery UUID, also useful for deduplication |
| `X-Mote-Event` | `material.archived` |
| `X-Mote-Timestamp` | ISO timestamp used in the signature |
| `X-Mote-Signature` | `sha256=<hex HMAC>` |

The signature input is:

```text
<timestamp>.<deliveryId>.<raw body>
```

with the endpoint's signing secret as the HMAC-SHA256 key. The full secret is
shown once when the endpoint is created or its secret is rotated. Receivers
should compare the signature in constant time and reject stale timestamps.

Targets must be `http` or `https`; embedded credentials, fragments, cloud
metadata addresses and redirects are refused. Loopback and LAN targets are
allowed so a local n8n or script can receive events. Deliveries have a finite
attempt budget and a request timeout. The management surface shows success,
failure and retry-pending status.

## Developer API

A developer credential is independent from owner, collector and MCP
credentials. It has a frozen source-ID list, `material.archived` event kinds and
a per-minute request limit. The full token is shown once; only its hash is
stored. Revocation immediately rejects further API requests.

```http
GET /api/developer/v1/events?after=<cursor>&limit=50
Authorization: Bearer <developer token>
```

The response contains only events inside the credential's declared source scope:

```json
{
  "events": [
    { "cursor": 42, "id": "evt_...", "type": "material.archived", "version": 1, "sourceId": "...", "occurredAt": "...", "material": { "id": "...", "revision": "...", "kind": "..." } }
  ],
  "nextCursor": 42,
  "hasMore": false
}
```

Management endpoints are owner-only and live under `/api/developer`:

- `GET /api/developer` — credentials, endpoints and recent delivery status
- `POST /api/developer/credentials` — mint a one-time developer token
- `DELETE /api/developer/credentials/:id` — revoke immediately
- `POST /api/developer/webhooks` — create an endpoint and show its secret once
- `PATCH /api/developer/webhooks/:id` — update scope, target, enable state or rotate the secret
- `DELETE /api/developer/webhooks/:id` — disable the endpoint
- `GET /api/developer/deliveries` — recent delivery status

Collectors, MCP tokens, developer tokens and read-only query agents cannot
create, widen, approve or revoke webhooks or developer credentials, install
plugins, change source authorization or write external actions.
