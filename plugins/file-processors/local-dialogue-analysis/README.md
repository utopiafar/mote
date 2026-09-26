# Local dialogue with central analysis

This explicitly selected alternative uses the native offline ASR and the chosen diarizer, while allowing derived text to be read by central Memory and query models. Unlike the private-dialogue example, it does not declare local-only content. Automatic summaries and semantic grouping remain choices in the user's processing profile; registering the module does not enable either.

Load `index.mjs` with `MOTE_FILE_PROCESSOR_PLUGINS`, restart, and assign a profile using `example.local-dialogue-analysis` to the intended audio source/type rule. Bind a local ASR service. An explicit model service can be selected for optional analysis; otherwise the configured central model is used. Existing files retain their completed policy until explicit reprocessing. Registering this plugin does not relax the built-in private profile.

For a generated acoustic control that will later feed a semantic journey, the existing media runner accepts `--processor-module /absolute/path/to/index.mjs --audio-processor example.local-dialogue-analysis --allow-generated-central-analysis`. That flag rejects personal-data manifests and still makes no LLM call. The resulting report records this disclosure choice. Confirm acoustic quality separately before using the transcript as semantic evidence.

Speaker labels remain anonymous until the owner explicitly supplies names. Names are scoped to a recording and carry a confirmation reference; the plugin does not identify people or decide which speaker is the owner.
