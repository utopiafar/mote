# Local media services

Central has separate installation roles for `ocr`, `dialogue`, `speaker-wespeaker` and `local-image`. Installing files, preparing dependencies, worker health, enabling a plugin and completing real inference are separate facts. Inspect `/api/media-models` and `/api/media-preparation`; local image plugin state is available at `/api/local-image-processing`.

## Models and platforms

| Role | Current implementation |
| --- | --- |
| OCR | Managed OCR worker and pinned asset catalog. |
| Dialogue | Fun-ASR-Nano-2512, FSMN VAD, CAM++ and CT-Punc under one dialogue installation. |
| Speaker WeSpeaker | Separate role for its declared consumers; the current FunASR pipeline does not borrow these assets. |
| Local image | InternVL3-14B-4bit, first targeting Native macOS Apple Silicon with MLX; optional plugin, default off. |

Exact required files, revisions, sizes, hashes and licenses live in [media-assets.ts](../apps/server/src/media-assets.ts) and [funasr-models.json](../scripts/funasr-models.json). Installation validates the complete catalog before atomically publishing a receipt. Old markers, mixed weights or a directory's existence do not establish readiness. Installation never grants background processing, starts historical scans or enables the image plugin.

Local image processing does not silently fall back to cloud. Memory, review and Ask retain their selected models and image-disclosure controls. Native and Linux/container audio paths need their own installation and inference evidence; module or generated-fixture success does not establish all-platform quality.

## Native preparation and offline import

Stop the selected Native profile before explicitly preparing its dependencies:

```sh
node scripts/mote.mjs media-runtime --profile dev --role ocr
node scripts/mote.mjs media-runtime --profile dev --role dialogue
node scripts/mote.mjs media-runtime --profile dev --role local-image
```

This prepares an isolated Python 3.11 environment for one role. `--python` selects its preparation interpreter. It does not install weights, start a worker or prove inference. Normal startup does not implicitly download new dependencies. Successful prepared environments can be reused after restart; failure preserves the last successful preparation record.

Offline bundles use the same verifier without downloading missing files:

```sh
node scripts/mote.mjs media-import --profile dev --role ocr --from /absolute/path/ocr-bundle
node scripts/mote.mjs media-import --profile dev --role dialogue --from /absolute/path/dialogue-bundle
node scripts/mote.mjs media-import --profile dev --role local-image --from /absolute/path/image-bundle
```

Bundles follow the current catalog: dialogue has `asr`, `vad`, `speaker` and `punctuation` subdirectories; image bundles retain required shards, indexes and processor configuration. Keep model volumes separate from original-data volumes. Compose uses its declared interpreters and does not provide macOS MLX.

## Worker controls

Native workers use role-specific environments and owned child processes. Ordinary restart restores prepared OCR/audio resources; the selected optional image plugin owns its worker lifecycle. Worker health includes protocol/model identity, not just an open port. Media directory, endpoint, port and credential changes need a restart; processing policy and authorization remain separate domain settings.

The local audio worker can be started explicitly with its prepared interpreter:

```sh
"$DIALOGUE_PYTHON" scripts/transcription-server.py \
  --model-root "$MODEL_DIRECTORY/dialogue" \
  --backend cpu --threads 4 --timeout 3600 --port 9009
```

Apple Silicon can select `--backend mps`; unsupported backends do not silently substitute. `MOTE_MEDIA_WORKER_TOKEN` comes from private configuration. The worker listens on `127.0.0.1`, authenticates health and execution endpoints, and admits one recording at a time. Inference children are recyclable. Central and worker need reachable loopback; a remote Central still requires TLS and a strong owner token.

`POST /transcribe` and `/diarize` use the native multipart request/audio contract; separation requires the retained recognition checkpoint. The optional `audio.http` interface is a different raw-byte contract. Managed workers do not inherit Central model credentials or third-party CLI credential stores. See [configuration](server-configuration.md), [processing](processing.md) and [deployment](deployment.md) for the surrounding system.
