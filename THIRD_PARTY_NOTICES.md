# Third-party sources and notices

This file identifies major runtime and model sources used by Mote. Exact JavaScript dependencies are recorded in `package-lock.json`; Android dependencies are declared in `apps/android/app/build.gradle.kts`. Preserve the licenses and notices shipped by those dependencies in redistributed binaries. This document is not a replacement for their complete license texts or transitive dependency notices.

## Local Qwen vision-language model

Mote uses the Qwen3.5-0.8B model and its image projector in GGUF format, distributed separately from the application package. The original [Qwen/Qwen3.5-0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B) and the [Unsloth GGUF repository](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/tree/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0) declare **Apache-2.0**. Preserve the model attribution and [Apache License 2.0](licenses/Apache-2.0.txt) with redistributed weights. Mote does not train or alter these weights.

The canonical artifact inventory is [models/qwen-manifest.json](models/qwen-manifest.json). Its primary [ModelScope source](https://modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF) is pinned to revision `88467eb7c8e3b6e7894c794f373050d4dbc6ae8a`; its Hugging Face fallback is pinned to `6ab461498e2023f6e3c1baea90a8f0fe38ab64d0`. These repositories have different revision identifiers but supply the same pinned artifact bytes:

| Upstream artifact / local name | Bytes | SHA-256 |
| --- | ---: | --- |
| `Qwen3.5-0.8B-Q4_K_M.gguf` / `model.gguf` | 532,517,120 | `bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517` |
| `mmproj-F16.gguf` / `mmproj.gguf` | 204,987,232 | `56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453` |

Downloads and offline imports must match both fixed hashes. A private NAS or another HTTPS host can serve the same files without changing the pinned model identity or verification policy. No accuracy, privacy guarantee, or upstream endorsement is implied. Configuration and limitations: [docs/local-inference.md](docs/local-inference.md).

## llama.cpp native runtime

Both endpoint applications compile the CPU implementation from [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp/tree/1744c6bde8d687ce9774b3b54e688eee0bfdf5b7), pinned to commit `1744c6bde8d687ce9774b3b54e688eee0bfdf5b7`. The engine includes llama.cpp, ggml and mtmd image processing components. Source preparation is performed by [scripts/setup-vision.sh](scripts/setup-vision.sh); downloading model weights is a separate operation.

- llama.cpp: [MIT license](licenses/llama.cpp-LICENSE.txt), copyright The ggml authors; preserve the [upstream license](https://github.com/ggml-org/llama.cpp/blob/1744c6bde8d687ce9774b3b54e688eee0bfdf5b7/LICENSE) and relevant source notices.
- stb image decoder: preserve its [license options and notice](licenses/stb-image-LICENSE.txt).
- nlohmann/json used by the desktop helper: preserve its [MIT license](licenses/nlohmann-json-LICENSE.txt).
- Compiler and platform runtime dependencies retain their own notices. This list does not replace the third-party license files shipped in the pinned upstream source.

Mote currently compiles and runs the CPU backend. Vulkan, Metal and MNN are not enabled or linked as Mote inference backends.

## DeepSeek Harness

The central query agent uses the official [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) runtime and TypeScript SDK:

- `@deepseek-ai/dsh`, `@deepseek-ai/dsh-sdk-client`, `@deepseek-ai/dsh-tools`: `0.1.5-rc.2`.
- `@deepseek-ai/cordis`: `4.0.2`.
- These published packages declare MIT. See the upstream [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/LICENSE) and each installed package's license files, including vendored component notices.

The integration does not bundle DeepSeek model weights or grant access to a hosted model. The user's separately configured model endpoint and provider terms govern that service.

## Application runtimes and libraries

The table lists principal direct libraries, not a complete software bill of materials. Build-time tools and transitive native libraries retain their own licenses.

| Component | Source / license |
| --- | --- |
| Electron | [electron/electron](https://github.com/electron/electron), MIT; preserve distributed Chromium and other third-party notices |
| React and React DOM | [facebook/react](https://github.com/facebook/react), MIT |
| Lucide React icons | [lucide-icons/lucide](https://github.com/lucide-icons/lucide), ISC; preserve included upstream icon notices |
| react-markdown | [remarkjs/react-markdown](https://github.com/remarkjs/react-markdown), MIT |
| Fastify | [fastify/fastify](https://github.com/fastify/fastify), MIT |
| sharp | [lovell/sharp](https://github.com/lovell/sharp), Apache-2.0; preserve libvips and other native dependency notices |
| Zod | [colinhacks/zod](https://github.com/colinhacks/zod), MIT |
| AndroidX WorkManager | [AndroidX source](https://android.googlesource.com/platform/frameworks/support/+/androidx-main/work/), Apache-2.0 |
| Google ML Kit text recognition | [ML Kit terms and privacy](https://developers.google.com/ml-kit/terms), Google SDK distribution terms; not described as an Apache-licensed model |
| Apple Vision / AppKit / ScreenCaptureKit APIs | Provided by macOS and the Apple SDK; no Apple model weights or operating-system framework binaries are copied into this repository |
