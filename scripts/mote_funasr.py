"""Pinned, offline FunASR engine for one recording in one disposable child.

ASR-02 calls run_audio with the current domain request, original file, and the
installed `dialogue` directory. It persists the recognize response before calling
again with operation=diarize. Errors carry domain codes; only the worker may
claim termination after reaping its child. No HTTP server, cache or process pool.

`python3 scripts/mote_funasr.py --manifest` exports CORE-01's exact asset input.
ModelScope metadata supplies sizes/SHA256; no weights are fetched by this module.
"""
from contextlib import contextmanager
import copy
import gc
import hashlib
import importlib.metadata
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from urllib.parse import urlencode, urlparse
import wave

import mote_asr_contract as contract
from mote_audio import (file_sha256, frame_interval, normalize, offline_process,
                        read_pcm, speaker_previews)

# Full, untrimmed PCM; independent VAD regions are never concatenated. Nano's
# token timings are deliberately not exported: the truthful common basis here
# is VAD precision, not interpolated words. CT-Punc is local, with no hotwords.
SETTINGS = {'sampleRate': 16000, 'maxSegmentMs': 30000, 'maxNewTokens': 512, 'batchSize': 1,
            'mergeVad': False, 'llmDtype': 'fp32', 'hotwords': False,
            'punctuation': 'per-vad', 'speakerWindowFrames': 24000,
            'speakerShiftFrames': 12000, 'speakerSmoothing': False}
SETTINGS_FINGERPRINT = hashlib.sha256(contract.serialize(SETTINGS).encode()).hexdigest()
SDK_SOURCES = {
    'auto/auto_model.py': '6e3aadc33b014452ca31c06e8261054fd94a26038caa60e669a6bfb70aa9abe1',
    'models/campplus/cluster_backend.py': '5bdea46a947e78be3c8501ab3ac4392a6d1107c8c9d727902c986264277c9140',
    'models/campplus/utils.py': '7fbbc06def205f3c2591923d72cbc78de1628d3d5789b54d54128eb06f4d0630',
    'models/fun_asr_nano/model.py': '12547e22620366b9607883e5d8444dee697ed3121251ac9adefee01d785dcfed',
    'download/download_model_from_hub.py': 'd88fd45c1ed90a3ec2a46d9630a57e81941472d8b791df174de22be573f1b340',
    'models/ct_transformer/model.py': 'fd38068e57f117e4f0d6f7bf4bf1dc3a30bec4e256e10d8f1adaadfe8c61cfb5',
    'utils/load_utils.py': 'c94ce198771935c22b467b9a279a219306df356e307d4c245d04c2d1dc7ef84d',
}

# Immutable ModelScope revisions, all relative to the frozen dialogue role.
BUNDLE = {
    'asr': {
        'revision': '05201c46f1c38592b1567f857c0d56eab3d0d8ef',
        'license': 'Apache-2.0',
        'files': [
            {'name': 'Qwen3-0.6B/config.json', 'size': 726, 'sha256': '660db3b73d788119c04535e48cf9be5f55bc3100841a718637ae695b442f27dd'},
            {'name': 'Qwen3-0.6B/generation_config.json', 'size': 239, 'sha256': '2325da0f15bb848e018c5ae071b7943332e9f871d6b60e2ed22ca97d4cb993d2'},
            {'name': 'Qwen3-0.6B/merges.txt', 'size': 1671853, 'sha256': '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5'},
            {'name': 'Qwen3-0.6B/tokenizer.json', 'size': 11422654, 'sha256': 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4'},
            {'name': 'Qwen3-0.6B/tokenizer_config.json', 'size': 9732, 'sha256': 'd5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101'},
            {'name': 'Qwen3-0.6B/vocab.json', 'size': 2776833, 'sha256': 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910'},
            {'name': 'config.yaml', 'size': 3140, 'sha256': 'daed38ea6484f5650fb32cbd9069b9aa13880acaf2bcb1f0bf4be2712837917c'},
            {'name': 'configuration.json', 'size': 398, 'sha256': 'b64a3a55d35bcbe2cf4d31f2d3ef25a423d3ba2ebff203298c27fa055f3c7612'},
            {'name': 'model.pt', 'size': 2127426538, 'sha256': '81fec8616083c69377f3ceef36aba3655660ee0ca69a5d4a1e9810cd340ca499'},
            {'name': 'multilingual.tiktoken', 'size': 907395, 'sha256': '747979631e813193436aabcff7c1c235d37de8097b71c563ec8b63b7a515c718'},
        ],
    },
    'vad': {
        'revision': 'f9a8b8274674755d925277e27063869038d41515',
        'license': 'Apache-2.0',
        'files': [
            {'name': 'am.mvn', 'size': 8040, 'sha256': '6820fef9687708c4fc3fab2530179c8fcea6262daa25514380056cd8f6eb1754'},
            {'name': 'config.yaml', 'size': 1215, 'sha256': '486861ca26ddb79081663b6179cb204c6bfae71c52f04aafc48a9e9d8dde1e93'},
            {'name': 'configuration.json', 'size': 365, 'sha256': '7bce8867e37d55c3dd8f672695ced18077a2be199ea529a5d432d5350fc0acba'},
            {'name': 'model.pt', 'size': 1721366, 'sha256': 'b3be75be477f0780277f3bae0fe489f48718f585f3a6e45d7dd1fbb1a4255fc5'},
        ],
    },
    'speaker': {
        'revision': 'a045b2afcaa9c3049c98a9215a2bc274407ab237',
        'license': 'Apache-2.0',
        'files': [
            {'name': 'campplus_cn_common.bin', 'size': 28036335, 'sha256': '3388cf5fd3493c9ac9c69851d8e7a8badcfb4f3dc631020c4961371646d5ada8'},
            {'name': 'config.yaml', 'size': 537, 'sha256': '17342041bd5b22f6fd7e32f6e7a267b0bf65f018c0a721bada6547e3d28fbfc9'},
            {'name': 'configuration.json', 'size': 581, 'sha256': '6f7acaf1e81ca121f4a3c71b6ddb66beec24350a3ef330e2c846f17829176a8f'},
        ],
    },
    'punctuation': {
        'revision': '45ab6961ad58a973ce7785401b4e93a0aab907a3',
        'license': 'Apache-2.0',
        'files': [
            {'name': 'config.yaml', 'size': 812, 'sha256': 'c5ffb25cd063ed366cb26283908dca05a08ecfef8e90bef1d498ef9ffacd7552'},
            {'name': 'configuration.json', 'size': 450, 'sha256': '7043245e6264cea789404e498a6f55a330a18585a4690d35dfe71741e6982237'},
            {'name': 'jieba.c.dict', 'size': 41536866, 'sha256': 'eb0a68f8bfa65e6956d59e8f9652b49f5c91952273e24737bc9a8c5e23055221'},
            {'name': 'jieba_usr_dict', 'size': 11280857, 'sha256': '059aa2af152734d5fd011a4d69cbab171f62347074db0db5157c17b5649010f5'},
            {'name': 'model.pt', 'size': 1125507622, 'sha256': '7176cae922a872e130e6b88aef9a1153581711baf79c9124c7c95be383cd6f81'},
            {'name': 'tokens.json', 'size': 8280697, 'sha256': '89951fe0669380ed33298ee048c4a2b0ebcaaf6ee8f332d85c281c41d0f38392'},
        ],
    },
}


class EngineError(RuntimeError):
    def __init__(self, code):
        if code not in contract.FAILURES:
            raise ValueError('Unknown engine failure')
        super().__init__(code)
        self.code = code


def component_manifest(role):
    return {'id': contract.MODEL_IDS[role], **copy.deepcopy(BUNDLE[role])}


def asset_manifest():
    """Handoff values, not a second installer or storage format."""
    components = {}
    for role in contract.MODEL_IDS:
        manifest = component_manifest(role)
        manifest['manifestSha256'] = hashlib.sha256(contract.serialize(manifest).encode()).hexdigest()
        manifest['directory'] = 'dialogue/' + role
        for item in manifest['files']:
            item['url'] = ('https://modelscope.cn/api/v1/models/' + contract.MODEL_IDS[role]
                           + '/repo?' + urlencode({'Revision': manifest['revision'], 'FilePath': item['name']}))
        components[role] = manifest
    return components


def verify_models(dialogue_directory):
    """Inspect the files actually loaded; never echo a requested model identity."""
    root = Path(dialogue_directory).resolve()
    models = {}
    for role in contract.MODEL_IDS:
        manifest = component_manifest(role)
        for item in manifest['files']:
            path = root / role / item['name']
            # Resolved symlinks outside this installation are not a pinned bundle.
            if root not in path.resolve().parents:
                raise EngineError('model_missing')
            try:
                if path.stat().st_size != item['size'] or file_sha256(path) != item['sha256']:
                    raise EngineError('model_missing')
            except OSError as error:
                raise EngineError('model_missing') from error
        models[role] = {'id': manifest['id'], 'revision': manifest['revision'],
                        'manifestSha256': hashlib.sha256(contract.serialize(manifest).encode()).hexdigest()}
    return models


def inspect_dependencies():
    """Critical runtime versions; transitive resolution is locked in requirements."""
    names = ('funasr', 'torch', 'torchaudio', 'transformers', 'numpy', 'scipy',
             'scikit-learn', 'librosa', 'soundfile', 'numba', 'llvmlite',
             'modelscope', 'umap-learn', 'einops', 'tokenizers', 'tiktoken',
             'huggingface-hub', 'omegaconf', 'hydra-core', 'threadpoolctl')
    try:
        versions = {name.replace('-', '_'): importlib.metadata.version(name) for name in names}
        # Reject drift before constructing models, including locally edited SDKs.
        locked = {}
        for line in Path(__file__).with_name('requirements-audio.txt').read_text().splitlines():
            item = line.split(';', 1)[0].strip()
            if '==' in item and not item.startswith('#'):
                name, version = item.split('==', 1)
                locked.setdefault(name.replace('-', '_'), set()).add(version.split()[0])
            elif ' @ ' in item:
                name, url = item.split(' @ ', 1)
                filename = Path(urlparse(url).path).name
                locked.setdefault(name.replace('-', '_'), set()).add(filename.split('-')[1])
        if any(versions[name.replace('-', '_')] not in locked.get(name.replace('-', '_'), set()) for name in names):
            raise EngineError('component_missing')
        distribution = importlib.metadata.distribution('funasr')
        for relative, digest in SDK_SOURCES.items():
            if file_sha256(distribution.locate_file('funasr/' + relative)) != digest:
                raise EngineError('component_missing')
    except (importlib.metadata.PackageNotFoundError, OSError) as error:
        raise EngineError('component_missing') from error
    return versions


class SdkRuntime:
    """Lazy local components; backend selection is explicit and never falls back."""
    def __init__(self, backend, threads):
        offline_process()
        if sys.version_info < (3, 11):
            raise EngineError('component_missing')
        for name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'NUMBA_NUM_THREADS'):
            os.environ[name] = str(threads)
        self.versions = inspect_dependencies()
        try:
            import numpy as np
            import torch
            from funasr import AutoModel
            from funasr.register import tables
        except (ImportError, OSError) as error:
            raise EngineError('component_missing') from error
        if any(tables.model_classes.get(name) is None for name in ('FunASRNano', 'FsmnVADStreaming', 'CAMPPlus', 'CTTransformer')):
            raise EngineError('component_missing')
        self.np, self.torch, self.auto_model = np, torch, AutoModel
        self.backend, self.threads = backend, threads
        self.active = None
        self.model_load_ms = self.model_release_ms = 0
        if backend not in ('cpu', 'mps') or backend == 'mps' and not torch.backends.mps.is_available():
            raise EngineError('worker_not_ready')
        torch.set_num_threads(threads)

    @contextmanager
    def component(self, role, directory):
        options = {'model': str(Path(directory).resolve()), 'device': self.backend,
                   'ncpu': self.threads, 'batch_size': 1, 'disable_update': True,
                   'disable_pbar': True, 'trust_remote_code': False}
        if role == 'asr':
            options['llm_conf'] = {'llm_dtype': SETTINGS['llmDtype']}
            options['max_length'] = SETTINGS['maxNewTokens']
        if role == 'vad':
            options['model_conf'] = {'max_single_segment_time': SETTINGS['maxSegmentMs']}
        llm = original_generate = None
        try:
            start = time.monotonic()
            try:
                self.active = self.auto_model(**options)
            finally:
                self.model_load_ms = getattr(self, 'model_load_ms', 0) + (time.monotonic()-start)*1000
            if self.active.kwargs['device'] != self.backend:
                raise EngineError('worker_not_ready')
            if role == 'asr':
                llm = self.active.model.llm
                original_generate = llm.generate
                def bounded_generate(*args, **kwargs):
                    tokens = original_generate(*args, **kwargs)
                    validate_generation(tokens.tolist(), kwargs['max_new_tokens'], llm.generation_config.eos_token_id)
                    return tokens
                llm.generate = bounded_generate
            yield self.active
        finally:
            if llm is not None and original_generate is not None:
                llm.generate = original_generate
                llm = original_generate = None
            start = time.monotonic()
            try:
                self.release()
            finally:
                self.model_release_ms = getattr(self, 'model_release_ms', 0) + (time.monotonic()-start)*1000

    def release(self):
        if self.active is not None:
            # Drop all AutoModel tensor owners even while the caller's local
            # variable still references its wrapper. Process exit is the final
            # resource boundary, supervised by ASR-02.
            for name in ('model', 'vad_model', 'punc_model', 'spk_model', 'cb_model'):
                if hasattr(self.active, name):
                    setattr(self.active, name, None)
            self.active = None
        gc.collect()
        if self.backend == 'mps':
            try:
                self.torch.mps.synchronize()
            finally:
                self.torch.mps.empty_cache()

    def waveform(self, pcm):
        return self.np.frombuffer(pcm, dtype='<i2').astype(self.np.float32) / 32768

    def cluster(self, embeddings, plan):
        from funasr.models.campplus import cluster_backend
        array = self.np.concatenate(embeddings, axis=0)
        cls = getattr(cluster_backend, plan['class'])
        return cls(**plan['init'])(array, **plan['call']).tolist()

    def embedding(self, result):
        embedding = result['spk_embedding'].detach().cpu().numpy()
        if embedding.shape != (1, 192) or not self.np.isfinite(embedding).all():
            raise EngineError('inference_failed')
        return embedding

    def close(self):
        self.release()


def one_result(value):
    if type(value) is not list or len(value) != 1 or type(value[0]) is not dict:
        raise EngineError('inference_failed')
    return value[0]


def validate_generation(sequences, limit, eos):
    """A capped decoder without EOS is partial, even if it produced some text."""
    eos = eos if isinstance(eos, (list, tuple)) else [eos]
    if not sequences or any(not row for row in sequences):
        raise EngineError('inference_failed')
    if any(len(row) >= limit and row[-1] not in eos for row in sequences):
        raise EngineError('output_limit')


def model_text(value, byte_limit, units=None):
    if type(value) is not str:
        raise EngineError('inference_failed')
    if len(value.encode('utf-8')) > byte_limit or units is not None and len(value.encode('utf-16-le'))//2 > units:
        raise EngineError('output_limit')


def check_cancelled(cancelled):
    if cancelled():
        raise EngineError('cancelled')


def recognize_pcm(request, source, identity, pcm, root, runtime, cancelled):
    frames = len(pcm) // 2
    if frames == 0:
        return contract.recognize_to_checkpoint(request, source, identity, {'value': []}, {'text': ''}, [], 'vad')
    with runtime.component('vad', root / 'vad') as model:
        vad = one_result(model.generate(input=runtime.waveform(pcm), cache={}, is_final=True,
                                        merge_vad=False, fs=16000))
    check_cancelled(cancelled)
    if type(vad.get('value')) is not list:
        raise EngineError('inference_failed')
    if len(vad['value']) > contract.LIMITS['vad']:
        raise EngineError('output_limit')
    previous_end = 0
    intervals = []
    for region in vad['value']:
        if type(region) not in (tuple, list) or len(region) != 2:
            raise EngineError('inference_failed')
        start, end = region
        # Reject incomplete final markers (-1), overlap or oversized chunks;
        # don't clamp, reorder, concatenate or silently drop a tail.
        first, last = frame_interval(start, end, frames)
        if start < previous_end or end - start > SETTINGS['maxSegmentMs']:
            raise EngineError('inference_failed')
        intervals.append((first, last))
        previous_end = end
    chunks = []
    if intervals:
        with runtime.component('asr', root / 'asr') as model:
            for first, last in intervals:
                check_cancelled(cancelled)
                result = one_result(model.generate(input=runtime.waveform(pcm[first*2:last*2]),
                                                   batch_size=1, fs=16000))
                model_text(result.get('text'), contract.LIMITS['textBytes'])
                chunks.append({'text': result['text']})
    # Keep the Nano text verbatim in recognitionChunks. Punctuation is a local
    # model stage, not deduplication or correction. No forced token timestamps.
    sentences = []
    if any(chunk['text'].strip() for chunk in chunks):
        with runtime.component('punctuation', root / 'punctuation') as model:
            for region, chunk in zip(vad['value'], chunks):
                check_cancelled(cancelled)
                if not chunk['text'].strip():
                    continue
                # Both AutoModel and its nested loader interpret leading URLs.
                # A list avoids file-list parsing; an unconditional newline
                # prevents URI parsing. CT-Punc's split_words uses str.split(),
                # so this transport prefix never becomes a model token.
                result = one_result(model.generate(input=['\n'+chunk['text']], batch_size=1))
                model_text(result.get('text'), 32000, 8000)
                if not result['text'].strip():
                    raise EngineError('inference_failed')
                sentences.append({'start': region[0], 'end': region[1], 'text': result['text']})
    check_cancelled(cancelled)
    return contract.recognize_to_checkpoint(request, source, identity, vad,
        {'text': '\n'.join(sentence['text'] for sentence in sentences), 'sentence_info': sentences}, chunks, 'vad')


def speaker_windows(vad, pcm):
    """Pinned sv_chunk geometry (1.5s/.75s), including its padded final window.

    Each tuple is (original start frame, original end frame, PCM16 bytes).
    Padding affects only model input, never the acoustic interval or next VAD.
    """
    windows = []
    for region in vad:
        first, last = frame_interval(region['startMs'], region['endMs'], len(pcm)//2)
        length, previous_end = last - first, 0
        for offset in range(0, length, SETTINGS['speakerShiftFrames']):
            end = min(offset + SETTINGS['speakerWindowFrames'], length)
            if end <= previous_end:
                break
            previous_end = end
            start = max(0, end - SETTINGS['speakerWindowFrames'])
            data = pcm[(first+start)*2:(first+end)*2]
            data += b'\0' * (SETTINGS['speakerWindowFrames']*2-len(data))
            windows.append((first+start, first+end, data))
            if len(windows) > contract.LIMITS['acousticSegments']:
                raise EngineError('output_limit')
    return windows


def acoustic_segments(windows, labels):
    """Official postprocess's temporal merge/midpoints, without label smoothing.

    SDK postprocess calls correct_labels (turning -1 noise into a person) and
    smooth (reassigning short interjections). Preserve the actual cluster IDs,
    noise and sub-10ms boundaries instead. This is geometry, not speaker inference.
    """
    if len(labels) != len(windows):
        raise EngineError('inference_failed')
    rows = []
    for (first, last, _pcm), label in zip(windows, labels):
        if label is not None:
            contract.number(label, -1, 99999, True)
            label = None if label == -1 else int(label)
        start, end = first/16, last/16
        if rows and rows[-1]['speaker'] == label and start <= rows[-1]['endMs']:
            rows[-1]['endMs'] = end
        else:
            rows.append({'startMs': start, 'endMs': end, 'speaker': label})
    for index in range(1, len(rows)):
        if rows[index]['startMs'] < rows[index-1]['endMs']:
            midpoint = (rows[index]['startMs'] + rows[index-1]['endMs']) / 2
            rows[index]['startMs'] = rows[index-1]['endMs'] = midpoint
    return rows


def assign_sentences(cp, rows):
    """SDK distribute_spk's total-overlap rule, with no fabricated default 0."""
    native = []
    for sentence in cp['sentences']:
        overlaps = {}
        for row in rows:
            duration = max(0, min(sentence['endMs'], row['endMs']) - max(sentence['startMs'], row['startMs']))
            if duration > 0:
                label = row['speaker']
                overlaps[label] = overlaps.get(label, 0) + duration
        native.append({'text': sentence['text'], 'start': sentence['startMs'], 'end': sentence['endMs'],
                       'spk': max(overlaps, key=overlaps.get) if overlaps else None})
    return native


def diarize_pcm(request, source, identity, pcm, root, runtime, normalized, cancelled):
    def cam(cp, options):
        windows = speaker_windows(cp['vad'], pcm)
        plan = contract.speaker_clustering_plan(options, len(windows))
        embeddings = []
        if windows:
            with runtime.component('speaker', root / 'speaker') as model:
                for _first, _last, data in windows:
                    check_cancelled(cancelled)
                    result = one_result(model.generate(input=runtime.waveform(data), batch_size=1, fs=16000))
                    embeddings.append(runtime.embedding(result))
            check_cancelled(cancelled)
            labels = runtime.cluster(embeddings, plan)
            check_cancelled(cancelled)
        else:
            labels = []
        rows = acoustic_segments(windows, labels)
        if options['mode'] != 'unknown':
            count = len({row['speaker'] for row in rows if row['speaker'] is not None})
            lower = options.get('count', options.get('min'))
            upper = options.get('count', options.get('max'))
            if not lower <= count <= upper:
                raise EngineError('constraint_unsatisfied')
        native = assign_sentences(cp, rows)
        # These intervals already use exact PCM milliseconds. The SDK seconds
        # adapter is only for native SDK seconds: a gratuitous round trip can
        # push a valid fractional final frame beyond the recording duration.
        result = {'timeUnit': 'ms', 'speakers': options, 'assignments': [s['spk'] for s in native],
                  'segments': rows, 'samples': speaker_previews(normalized, rows)}
        contract.validate_diarization(result, cp)
        return result
    return contract.diarize_from_checkpoint(request, source, identity, cam, cancelled)


def run_audio(request, original, dialogue_directory, *, backend, threads, timeout=600,
              cancelled=lambda: False, metrics=None, started_at=None, runtime_factory=SdkRuntime):
    """Return the frozen serializer's UTF-8 JSON; never return partial success.

    `started_at` is monotonic time taken by ASR-02 BEFORE spawning this child.
    The optional numeric-only metrics callback receives full cold request cost,
    normalization, asset verification, runtime load, inference and release cost.
    It belongs in diagnostics, outside the frozen wire payload. No timings here
    are a benchmark or a substitute for the later real-model platform acceptance.
    """
    begin = time.monotonic() if started_at is None else started_at
    timings, runtime = {}, None
    try:
        try:
            request = contract.parse_request(request)
        except (ValueError, UnicodeError, TypeError, KeyError) as error:
            raise EngineError('contract_mismatch') from error
        if type(threads) is not int or not 1 <= threads <= 32 or backend not in ('cpu', 'mps'):
            raise EngineError('worker_not_ready')
        try:
            if Path(original).stat().st_size > 512*1024*1024 or file_sha256(original) != request['audioSha256']:
                raise EngineError('invalid_input')
        except OSError as error:
            raise EngineError('invalid_input') from error
        check_cancelled(cancelled)
        with TemporaryDirectory(prefix='mote-funasr-') as temporary:
            normalized = Path(temporary) / 'normalized.wav'
            start = time.monotonic()
            try:
                normalize(original, normalized, request['maxAudioMs'], timeout)
                pcm = read_pcm(normalized)
            except FileNotFoundError as error:
                raise EngineError('component_missing') from error
            except subprocess.TimeoutExpired as error:
                raise EngineError('inference_timeout') from error
            except (ValueError, OverflowError, subprocess.CalledProcessError, wave.Error, EOFError) as error:
                raise EngineError('unsupported_input') from error
            source = {'audioSha256': request['audioSha256'], 'pcmSha256': hashlib.sha256(pcm).hexdigest(),
                      'sampleRate': 16000, 'sampleCount': len(pcm)//2, 'durationMs': len(pcm)/32,
                      'timeline': 'original'}
            if request['operation'] == 'diarize' and contract.read_checkpoint(request['checkpoint'])['source'] != source:
                raise EngineError('contract_mismatch')
            timings['normalizationMs'] = (time.monotonic()-start)*1000
            start = time.monotonic()
            models = verify_models(dialogue_directory)
            timings['assetVerificationMs'] = (time.monotonic()-start)*1000
            start = time.monotonic()
            runtime = runtime_factory(backend, threads)
            identity = {'sdkVersion': contract.SDK_VERSION, 'sdkWheelSha256': contract.SDK_WHEEL_SHA256,
                        **copy.deepcopy(contract.PINS), 'settingsFingerprint': SETTINGS_FINGERPRINT,
                        'models': models, 'dependencies': runtime.versions, 'backend': backend, 'threads': threads}
            contract.validate_identity(identity)
            if identity != request['identity']:
                raise EngineError('contract_mismatch')
            timings['runtimeLoadMs'] = (time.monotonic()-start)*1000
            check_cancelled(cancelled)
            start = time.monotonic()
            args = (request, source, identity, pcm, Path(dialogue_directory), runtime)
            if request['operation'] == 'recognize':
                response = recognize_pcm(*args, cancelled)
            else:
                response = diarize_pcm(*args, normalized, cancelled)
            # Use the actual consumer before returning, including identity and
            # exact saved checkpoint digest on a CAM-only retry.
            contract.parse_response(response, request)
            timings['modelLoadMs'] = getattr(runtime, 'model_load_ms', 0)
            timings['modelReleaseMs'] = getattr(runtime, 'model_release_ms', 0)
            timings['inferenceMs'] = max(0, (time.monotonic()-start)*1000
                                        - timings['modelLoadMs'] - timings['modelReleaseMs'])
            return response
    except EngineError:
        raise
    except OverflowError as error:
        raise EngineError('output_limit') from error
    except contract.ContractError as error:
        code = ('cancelled' if str(error).startswith('Cancelled') else
                'constraint_unsatisfied' if str(error) == 'constraint_unsatisfied' else 'inference_failed')
        raise EngineError(code) from error
    except Exception as error:
        raise EngineError('inference_failed') from error
    finally:
        start = time.monotonic()
        try:
            if runtime is not None:
                runtime.close()
        finally:
            timings['releaseMs'] = (time.monotonic()-start)*1000
            timings['coldRequestMs'] = (time.monotonic()-begin)*1000
            if metrics is not None:
                metrics(timings)


if __name__ == '__main__':
    if sys.argv[1:] == ['--manifest']:
        print(contract.serialize(asset_manifest()))
    else:
        raise SystemExit('Import run_audio in the isolated audio child; --manifest exports asset metadata.')
