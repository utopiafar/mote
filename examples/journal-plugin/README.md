# Journal plugin example

A plugin package that combines one namespaced journal source connector with the
deterministic source recipe, aggregation, product consumer and catalog anchors
that publish a journal material. Both surfaces are contributions of one
`mote-plugin.json`; `plugin.mjs` exports the connector as `connector` and the
Cordis backend plugin as `backendPlugin`.

The package does not scan a vault or call a model. Load it through
`plugin-dev dev --plugin examples/journal-plugin` or a host that consumes the
declared ingress and processing contributions. Generated data only.
