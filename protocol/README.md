# Wire compatibility

Central, Desktop and Android have independent product release versions. A product
version describes the installed build; it does not prove API compatibility or
authorize a feature. The shared wire contract is declared in [contract.json](contract.json)
and implemented by `@mote/shared/protocol` and Android `ProtocolCompatibility`.
Current products support the inclusive range `{ "min": 1, "max": 1 }`.

`GET /api/health` returns `{ok,version,protocol}` without authentication. `version`
is the Central release version, and `protocol` is its supported wire range.
This public health response does not disclose credential capabilities.

Native connection checks send `X-Mote-Protocol-Version: 1` to the authenticated
`GET /api/connections/self` endpoint. Any present value requests metadata, so a
future client can still discover an incompatible server range. The server adds
`node.protocol` to its existing `{credential,node,capabilities}` response. Without
this header, the response retains its previous shape because already-installed
Desktop clients reject unknown fields. The header only requests disclosure; it
does not bypass authentication or select a different ingestion behavior.

Clients validate integer bounds, `min <= max`, and range overlap. A provided
malformed or non-overlapping range fails the connection check before applying a
new credential. Missing metadata means the existing v1 API, preserving connections
to servers shipped before this handshake. Existing endpoint, authorization and
ingress receipt checks still apply. Product version strings are never compared
across Central, Desktop and Android to decide compatibility.

`capabilities.ingest`, `ownSources` and `archiveRead` describe the authenticated
credential's existing authorization. They do not promise new product features.
`capabilities.ingressVersion` retains the existing collector ingress subprotocol
(currently 2), including `X-Mote-Ingress-Version` enforcement and durable ACK
validation. The connection handshake does not replace that guard. Server and its
bundled Web console remain one release unit and retain their build consistency
check.

Additive changes must retain existing request and response behavior, including
strict older consumers. New fields can use an explicit opt-in, as above. A future
incompatible wire change must update the supported range and these generated
fixtures, provide an upgrade path, and retain old readers while older collectors
remain supported. Changes to this directory or `@mote/shared` require validating
all consumers; they do not require releasing every product.

The fixture cases in [fixtures/compatibility.json](fixtures/compatibility.json)
are consumed by shared TypeScript, Desktop connection and Android JVM tests.
They contain generated values only. Physical-device and live-model checks are
separate validations.
