# Wire compatibility

Central, Desktop and Android have independent product release versions. A product
version describes the installed build; it does not prove API compatibility or
authorize a feature. The shared wire contract is declared in [contract.json](contract.json)
and implemented by `@mote/shared/protocol` and Android `ProtocolCompatibility`.
Current products support the inclusive range `{ "min": 1, "max": 1 }`.

`GET /api/health` returns `{ok,version,protocol}` without authentication. `version`
is the Central release version, and `protocol` is its supported wire range.
This public health response does not disclose credential capabilities.

Native connection checks send `X-Mote-Protocol-Version: 1` to authenticated
`GET /api/connections/self`. Every successful response includes `node.protocol`
alongside `{credential,node,capabilities}`. The header does not bypass
authentication or select a different ingestion behavior.

Clients require integer bounds, `min <= max`, and range overlap. Missing,
malformed, or non-overlapping metadata fails the connection check before applying
a credential. Pre-handshake nodes are retired by this MVP upgrade. Product
versions are never compared across Central, Desktop and Android to decide API
compatibility.

`capabilities.ingest`, `ownSources` and `archiveRead` describe the authenticated
credential's existing authorization. They do not promise new product features.
`capabilities.ingressVersion` retains the existing collector ingress subprotocol
(currently 2), including `X-Mote-Ingress-Version` enforcement and durable ACK
validation. The connection handshake does not replace that guard. Server and its
bundled Web console remain one release unit and retain their build consistency
check.

Storage epochs and release tags are independent of the wire range. This cleanup
uses Central and native local format 3 while retaining wire range 1 and collector
ingress 2. Unsupported stored formats fail explicitly without rewriting their
files. See the compatibility cleanup audit for the destructive MVP upgrade steps.
Future wire changes must update the supported range and generated fixtures, and
validate all consumers.

The fixture cases in [fixtures/compatibility.json](fixtures/compatibility.json)
are consumed by shared TypeScript, Desktop connection and Android JVM tests.
They contain generated values only. Physical-device and live-model checks are
separate validations.
