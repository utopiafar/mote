# Text normalization plugin example

A plugin package that registers one deterministic context processor which
normalizes CRLF to LF without changing the original evidence. It is installed as
a processing contribution from `mote-plugin.json`; `plugin.mjs` is the Cordis
backend plugin.

Load it through `plugin-dev dev --plugin examples/text-normalization-plugin` or a
host that consumes the declared processing contribution.
