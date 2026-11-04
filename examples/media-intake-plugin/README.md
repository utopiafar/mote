# Media intake plugin example

A plugin package that registers one structural text format, output schema,
normalization stage and file recipe. It is installed as a processing
contribution from `mote-plugin.json`; `plugin.mjs` is the Cordis backend plugin.

Load it through `plugin-dev dev --plugin examples/media-intake-plugin` or a host
that consumes the declared processing contribution. Structural normalization
only; captured content is never executable instructions.
