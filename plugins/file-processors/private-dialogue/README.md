# Private dialogue composition

This trusted Cordis module registers `example.private-dialogue` by composing the native offline audio processor. It retains local execution, local-only derived content, the selected diarizer and alignment, optional local semantic grouping, and disabled automatic summaries. Its version includes the native processor version so an implementation upgrade cannot reuse an incompatible checkpoint.

Load the module in the central deployment and restart:

```dotenv
MOTE_FILE_PROCESSOR_PLUGINS=["/absolute/mote/plugins/file-processors/private-dialogue/index.mjs"]
```

In File processing settings, create a processing profile using **Example private dialogue**, bind a local ASR service, choose a diarizer, and assign that profile to an audio source/type rule. Existing completed files require explicit reprocessing to apply the new profile. No upload, queue, archive or query implementation needs to change to install this module.

For an isolated generated acoustic control:

```sh
node --import tsx scripts/test-file-journey-live.ts \
  --manifest /absolute/control/manifest.json \
  --output /absolute/new-private-output \
  --python /absolute/media-venv/bin/python \
  --asr-model-root /absolute/preinstalled-models \
  --processor-module /absolute/mote/plugins/file-processors/private-dialogue/index.mjs \
  --audio-processor example.private-dialogue
```

The runner records the module, processing code and model hashes; verifies original bytes; and exercises real local ASR, diarization, alignment and evidence reads. It makes no LLM call and does not test a browser or physical device. Score the closed output with `scripts/evaluate-audio-control.py` and the generated control's reference. Keep input, output and model files outside Git. See [file processing](../../../docs/file-processing.md) for capability contracts and quality limitations.
