"""Generated model boundaries; real hashing, PCM mapping, limits and consumers.

--emit serializes the actual engine's generated run, for downstream owners.
It never loads weights, imports a model runtime or uses personal recordings.
"""
from contextlib import contextmanager
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
import weakref

import mote_asr_contract as contract
import mote_funasr as engine
from test_mote_audio import generated_wav


class GeneratedRuntime:
    versions = {'funasr': contract.SDK_VERSION, 'torch': '2.8.0'}

    def __init__(self, vad, texts, punctuated, labels=()):
        self.vad, self.texts, self.punctuated, self.labels = vad, list(texts), list(punctuated), list(labels)
        self.calls, self.closed, self.released = [], 0, []
        self.failure, self.after_generate = None, lambda _role: None

    @contextmanager
    def component(self, role, directory):
        self.calls.append(('load', role, str(directory)))
        def generate(**kwargs):
            self.calls.append(('generate', role, kwargs))
            self.after_generate(role)
            if self.failure == role:
                raise RuntimeError('Generated external model failure')
            if role == 'vad':
                return [{'value': self.vad}]
            if role == 'asr':
                return [{'text': self.texts.pop(0)}] if self.texts else []
            if role == 'punctuation':
                return [{'text': self.punctuated.pop(0)}]
            return [{'spk_embedding': 'generated embedding'}]
        try:
            yield SimpleNamespace(generate=generate)
        finally:
            self.released.append(role)

    def waveform(self, pcm):
        return pcm

    def embedding(self, result):
        return result['spk_embedding']

    def cluster(self, embeddings, plan):
        self.calls.append(('cluster', copy.deepcopy(plan), len(embeddings)))
        if self.failure == 'cluster':
            raise RuntimeError('Generated clustering failure')
        return list(self.labels)

    def close(self):
        self.closed += 1


@contextmanager
def generated_engine(frames=64000):
    with tempfile.TemporaryDirectory(prefix='mote-funasr-test-') as temporary:
        root = Path(temporary)
        original = root/'generated.wav'
        pcm = generated_wav(original, frames)
        bundle, models = {}, root/'dialogue'
        for role in contract.MODEL_IDS:
            directory = models/role
            directory.mkdir(parents=True)
            content = ('Generated inert asset for '+role).encode()
            (directory/'generated.bin').write_bytes(content)
            bundle[role] = {'revision': hashlib.sha256(('generated revision '+role).encode()).hexdigest(),
                            'license': 'Apache-2.0', 'files': [{'name': 'generated.bin', 'size': len(content),
                            'sha256': hashlib.sha256(content).hexdigest()}]}
        with patch.object(engine, 'BUNDLE', bundle):
            identity = {'sdkVersion': contract.SDK_VERSION, 'sdkWheelSha256': contract.SDK_WHEEL_SHA256,
                        **copy.deepcopy(contract.PINS), 'settingsFingerprint': engine.SETTINGS_FINGERPRINT,
                        'models': engine.verify_models(models), 'dependencies': GeneratedRuntime.versions,
                        'backend': 'cpu', 'threads': 2}
            request = {'protocol': contract.PROTOCOL, 'operation': 'recognize',
                       'audioSha256': hashlib.sha256(original.read_bytes()).hexdigest(),
                       'maxAudioMs': max(1, frames/16), 'identity': identity}
            def run(runtime, supplied=None, **kwargs):
                return engine.run_audio(supplied or request, original, models, backend='cpu', threads=2,
                                        runtime_factory=lambda _backend, _threads: runtime, **kwargs)
            yield SimpleNamespace(root=root, original=original, pcm=pcm, models=models,
                                  request=request, run=run)


def diarize_request(request, response, speakers=None):
    return {**request, 'operation': 'diarize', 'checkpoint': json.loads(response)['checkpoint'],
            'speakers': speakers or {'mode': 'unknown'}}


def generated_bundle():
    with generated_engine() as f:
        recognizer = GeneratedRuntime([[1000, 1500], [3000, 4000]], [' 合成原文 ', '尾段'], ['合成原文。', '尾段。'])
        response = f.run(recognizer)
        request = diarize_request(f.request, response)
        diarization = f.run(GeneratedRuntime([], [], [], [0, 7]), request)
        return {'request': f.request, 'response': response, 'diarizeRequest': request, 'diarizeResponse': diarization}


@unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg is required for generated engine integration')
class FunasrEngine(unittest.TestCase):
    def test_separate_speech_clips_keep_original_pcm_time_and_tail_without_repacking(self):
        with generated_engine(frames=64001) as f:
            runtime = GeneratedRuntime([[1000, 1500], [3000, 4000.0625]], [' 首块 ', '最后一个采样'], ['首块。', '最后一个采样。'])
            response = contract.parse_response(f.run(runtime), f.request)
            cp = contract.read_checkpoint(response['checkpoint'])
            inputs = [call[2]['input'] for call in runtime.calls if call[:2] == ('generate', 'asr')]
            self.assertEqual(inputs, [f.pcm[32000:48000], f.pcm[96000:128002]])
            self.assertEqual(cp['source']['durationMs'], 4000.0625)
            self.assertEqual([(s['startMs'], s['endMs']) for s in cp['sentences']], [(1000, 1500), (3000, 4000.0625)])
            self.assertEqual(cp['recognitionChunks'], [{'vadIndex': 0, 'text': ' 首块 '}, {'vadIndex': 1, 'text': '最后一个采样'}])
            self.assertEqual(cp['sentences'][-1]['text'], '最后一个采样。')
            self.assertTrue(all(s['precision'] == 'vad' and 'words' not in s for s in cp['sentences']))
            self.assertEqual(runtime.released, ['vad', 'asr', 'punctuation'])
            self.assertEqual(runtime.closed, 1)
            self.assertNotIn('speaker', runtime.released)
            self.assertEqual(hashlib.sha256(f.original.read_bytes()).hexdigest(), f.request['audioSha256'])

    def test_silence_never_calls_asr_punctuation_or_speaker_and_keeps_full_duration(self):
        for frames in (0, 64000):
            with generated_engine(frames) as f:
                runtime = GeneratedRuntime([], [], [])
                response = contract.parse_response(f.run(runtime), f.request)
                cp = contract.read_checkpoint(response['checkpoint'])
                self.assertEqual(cp['text'], '')
                self.assertEqual(cp['sentences'], [])
                self.assertEqual(cp['source']['durationMs'], frames/16)
                self.assertEqual(runtime.released, ['vad'] if frames else [])
                retry = diarize_request(f.request, contract.serialize(response))
                cam = GeneratedRuntime([], [], [])
                result = contract.parse_response(f.run(cam, retry), retry)
                self.assertEqual(result['diarization']['segments'], [])
                self.assertEqual(cam.calls, [])
                self.assertEqual(cam.closed, 1)

    def test_invalid_overlapping_nonfinite_and_incomplete_vad_never_start_asr(self):
        for vad in ([[0, 4001]], [[0, 2000], [1900, 3000]], [[-1, 100]], [[10, -1]],
                    [[0, float('inf')]], [[float('nan'), 100]], [[100, 100]]):
            with self.subTest(vad=vad), generated_engine() as f:
                runtime = GeneratedRuntime(vad, ['must not run'], [])
                with self.assertRaises(engine.EngineError):
                    f.run(runtime)
                self.assertEqual(runtime.released, ['vad'])
                self.assertEqual(runtime.closed, 1)

    def test_clip_over_decoder_capacity_fails_even_inside_original_duration(self):
        with generated_engine(640000) as f:
            runtime = GeneratedRuntime([[0, 30000.0625]], [], [])
            with self.assertRaises(engine.EngineError):
                f.run(runtime)
            self.assertEqual(runtime.released, ['vad'])

    def test_missing_final_asr_result_cannot_become_complete_success(self):
        with generated_engine() as f:
            runtime = GeneratedRuntime([[0, 1000], [3000, 4000]], ['first only'], [])
            with self.assertRaisesRegex(engine.EngineError, 'inference_failed'):
                f.run(runtime)
            self.assertEqual(runtime.released, ['vad', 'asr'])
            self.assertEqual(runtime.closed, 1)

    def test_recognized_text_is_inert_at_the_punctuation_url_and_file_boundary(self):
        for raw in ('https://example.invalid/generated-transcript', 'scripts/mote_funasr.py'):
            with self.subTest(raw=raw), generated_engine() as f:
                runtime = GeneratedRuntime([[0, 1000]], [raw], ['合成标点结果。'])
                response = f.run(runtime)
                call = next(c for c in runtime.calls if c[:2] == ('generate', 'punctuation'))
                self.assertEqual(call[2]['input'], ['\n'+raw])
                self.assertEqual(contract.read_checkpoint(json.loads(response)['checkpoint'])['recognitionChunks'][0]['text'], raw)

    def test_text_limits_fail_without_truncating_recognized_evidence(self):
        with generated_engine() as f:
            runtime = GeneratedRuntime([[0, 1000]], ['raw'], ['文'*8001])
            with self.assertRaisesRegex(engine.EngineError, 'output_limit'):
                f.run(runtime)
            self.assertEqual(runtime.released, ['vad', 'asr', 'punctuation'])
            self.assertEqual(runtime.closed, 1)

    def test_raw_empty_asr_chunks_are_complete_without_fabricating_a_sentence(self):
        with generated_engine() as f:
            runtime = GeneratedRuntime([[0, 1000]], [''], [])
            cp = contract.read_checkpoint(json.loads(f.run(runtime))['checkpoint'])
            self.assertEqual(cp['recognitionChunks'], [{'vadIndex': 0, 'text': ''}])
            self.assertEqual(cp['sentences'], [])
            self.assertNotIn('punctuation', runtime.released)

    def test_fractional_pcm_tail_is_not_rejected_by_a_seconds_round_trip(self):
        # 250.0625 / 1000 * 1000 > 250.0625 in IEEE double precision.
        with generated_engine(4001) as f:
            response = f.run(GeneratedRuntime([[0, 250.0625]], ['raw tail'], ['尾段。']))
            request = diarize_request(f.request, response)
            result = contract.parse_response(f.run(GeneratedRuntime([], [], [], [0]), request), request)
            self.assertEqual(result['diarization']['segments'], [{'startMs': 0, 'endMs': 250.0625, 'speaker': 0}])
            self.assertEqual(result['diarization']['assignments'], [0])

    def test_cam_failure_keeps_archived_recognition_and_retry_does_not_repeat_asr(self):
        with generated_engine() as f:
            response = f.run(GeneratedRuntime([[0, 1000], [3000, 4000]], ['one', 'two'], ['one.', 'two.']))
            archive_path = f.root/'recognition.json'
            archive_path.write_text(contract.serialize(json.loads(response)['checkpoint']))
            request = diarize_request(f.request, response)
            failed = GeneratedRuntime([], [], [], [0, 9])
            failed.failure = 'speaker'
            with self.assertRaisesRegex(engine.EngineError, 'inference_failed'):
                f.run(failed, request)
            self.assertEqual(failed.released, ['speaker'])
            self.assertEqual(failed.closed, 1)
            request['checkpoint'] = json.loads(archive_path.read_text())
            retry = GeneratedRuntime([], [], [], [0, 9])
            result = contract.parse_response(f.run(retry, request), request)
            self.assertEqual(result['checkpoint'], json.loads(archive_path.read_text()))
            self.assertEqual(result['diarization']['assignments'], [0, 9])
            self.assertEqual(retry.released, ['speaker'])
            self.assertEqual([call[0] for call in retry.calls].count('cluster'), 1)
            for clip in result['diarization']['samples']:
                with wave.open(io.BytesIO(base64.b64decode(clip['wavBase64']))) as wav:
                    self.assertEqual(wav.getnframes(), int((clip['endMs']-clip['startMs'])*16))
                    self.assertEqual(wav.getframerate(), 16000)

    def test_speaker_declarations_reach_the_frozen_real_clustering_entrypoints(self):
        cases = [({'mode': 'unknown'}, {'class': 'ClusterBackend', 'init': {'max_num_spks': 16}, 'call': {'oracle_num': None}}),
                 ({'mode': 'exact', 'count': 2}, {'class': 'SpectralCluster', 'init': {'min_num_spks': 2, 'max_num_spks': 2}, 'call': {'oracle_num': 2}}),
                 ({'mode': 'range', 'min': 2, 'max': 4}, {'class': 'SpectralCluster', 'init': {'min_num_spks': 2, 'max_num_spks': 2}, 'call': {'oracle_num': None}})]
        with generated_engine() as f:
            response = f.run(GeneratedRuntime([[0, 1000], [1500, 2000], [3000, 4000]], ['one', 'two', 'three'], ['one.', 'two.', 'three.']))
            for options, plan in cases:
                with self.subTest(options=options):
                    runtime = GeneratedRuntime([], [], [], [0, 1, 1])
                    request = diarize_request(f.request, response, options)
                    result = contract.parse_response(f.run(runtime, request), request)
                    self.assertEqual(next(c for c in runtime.calls if c[0] == 'cluster'), ('cluster', plan, 3))
                    self.assertEqual(result['diarization']['speakers'], options)
            for options, labels in [({'mode': 'exact', 'count': 2}, [0, 0, 0]), ({'mode': 'range', 'min': 2, 'max': 3}, [0, -1, -1])]:
                with self.subTest(options=options), self.assertRaisesRegex(engine.EngineError, 'constraint_unsatisfied'):
                    f.run(GeneratedRuntime([], [], [], labels), diarize_request(f.request, response, options))

    def test_unknown_count_keeps_all_model_labels_beyond_the_sixteen_previews(self):
        with generated_engine(189*8000) as f:
            vad = [[i*500, i*500+400] for i in range(189)]
            response = f.run(GeneratedRuntime(vad, ['raw']*189, ['合成。']*189))
            runtime = GeneratedRuntime([], [], [], list(range(189)))
            request = diarize_request(f.request, response)
            result = contract.parse_response(f.run(runtime, request), request)
            self.assertEqual(result['diarization']['assignments'], list(range(189)))
            self.assertEqual([s['speaker'] for s in result['diarization']['segments']], list(range(189)))
            self.assertEqual(len(result['diarization']['samples']), 16)
            self.assertEqual(len(contract.read_checkpoint(result['checkpoint'])['sentences']), 189)

    def test_wrong_assets_original_runtime_or_checkpoint_identity_never_run_models(self):
        with generated_engine() as f:
            runtime = GeneratedRuntime([], [], [])
            for key in ('models', 'dependencies', 'settingsFingerprint'):
                request = copy.deepcopy(f.request)
                if key == 'models':
                    request['identity'][key]['speaker']['manifestSha256'] = '0'*64
                elif key == 'dependencies':
                    request['identity'][key]['torch'] = '9.0.0'
                else:
                    request['identity'][key] = '0'*64
                with self.subTest(key=key), self.assertRaisesRegex(engine.EngineError, 'contract_mismatch'):
                    f.run(runtime, request)
            self.assertEqual(runtime.calls, [])
            asset = f.models/'speaker'/'generated.bin'
            asset.write_bytes(b'x'*asset.stat().st_size)
            with self.assertRaisesRegex(engine.EngineError, 'model_missing'):
                f.run(runtime)
            with self.assertRaisesRegex(engine.EngineError, 'invalid_input'):
                f.run(runtime, {**f.request, 'audioSha256': '0'*64})
            self.assertEqual(runtime.calls, [])

    def test_renormalized_pcm_mismatch_cannot_start_cam_after_a_restart(self):
        with generated_engine() as f:
            response = f.run(GeneratedRuntime([], [], []))
            request = diarize_request(f.request, response)
            cp = contract.read_checkpoint(request['checkpoint'])
            cp['source']['pcmSha256'] = '0'*64
            request['checkpoint'] = contract.archive_checkpoint(cp)
            runtime = GeneratedRuntime([], [], [])
            with self.assertRaisesRegex(engine.EngineError, 'contract_mismatch'):
                f.run(runtime, request)
            self.assertEqual(runtime.calls, [])
            self.assertEqual(runtime.closed, 0)

    def test_bad_audio_and_duration_budget_fail_before_any_model_call(self):
        with generated_engine() as f:
            runtime = GeneratedRuntime([], [], [])
            with self.assertRaisesRegex(engine.EngineError, 'unsupported_input'):
                f.run(runtime, {**f.request, 'maxAudioMs': 500})
            f.original.write_bytes(b'generated invalid audio')
            request = {**f.request, 'audioSha256': hashlib.sha256(f.original.read_bytes()).hexdigest()}
            with self.assertRaisesRegex(engine.EngineError, 'unsupported_input'):
                f.run(runtime, request)
            self.assertEqual(runtime.calls, [])
            self.assertEqual(runtime.closed, 0)

    def test_cancellation_before_or_during_models_releases_without_publishing(self):
        with generated_engine() as f:
            runtime = GeneratedRuntime([[0, 1000]], ['raw'], ['文本。'])
            with self.assertRaisesRegex(engine.EngineError, 'cancelled'):
                f.run(runtime, cancelled=lambda: True)
            self.assertEqual(runtime.calls, [])
            cancelled = []
            runtime.after_generate = lambda role: cancelled.append(role)
            with self.assertRaisesRegex(engine.EngineError, 'cancelled'):
                f.run(runtime, cancelled=lambda: bool(cancelled))
            self.assertEqual(runtime.released, ['vad'])
            self.assertEqual(runtime.closed, 1)

    def test_cancellation_during_clustering_releases_cam_and_keeps_checkpoint(self):
        with generated_engine() as f:
            response = f.run(GeneratedRuntime([[0, 1000]], ['raw'], ['原文。']))
            request = diarize_request(f.request, response)
            archive = copy.deepcopy(request['checkpoint'])
            runtime, cancelled = GeneratedRuntime([], [], [], [0]), []
            cluster = runtime.cluster
            def during_cluster(embeddings, plan):
                labels = cluster(embeddings, plan)
                cancelled.append(True)
                return labels
            runtime.cluster = during_cluster
            with self.assertRaisesRegex(engine.EngineError, 'cancelled'):
                f.run(runtime, request, cancelled=lambda: bool(cancelled))
            self.assertEqual(request['checkpoint'], archive)
            self.assertEqual(runtime.released, ['speaker'])
            self.assertEqual(runtime.closed, 1)

    def test_cold_request_metrics_include_normalization_loading_inference_and_cleanup(self):
        with generated_engine() as f:
            metrics = []
            f.run(GeneratedRuntime([], [], []), metrics=metrics.append)
            self.assertEqual(set(metrics[0]), {'normalizationMs', 'assetVerificationMs', 'runtimeLoadMs', 'modelLoadMs', 'modelReleaseMs', 'inferenceMs', 'releaseMs', 'coldRequestMs'})
            self.assertTrue(all(isinstance(value, (int, float)) and value >= 0 for value in metrics[0].values()))
            self.assertGreaterEqual(metrics[0]['coldRequestMs'], sum(v for k, v in metrics[0].items() if k != 'coldRequestMs'))

    def test_real_engine_serialization_reaches_typescript_file_output_registry(self):
        # Cross-language consumer uses the actual run_audio bytes above, never a
        # separately handwritten TS success fixture or a fake Store/HTTP stack.
        bundle = generated_bundle()
        code = """
import {FileOutputRegistry} from './apps/server/src/file-recipes.ts';
import {parseFunasrRequest,parseFunasrResponse,parseFunasrArchive,projectFunasrDiarization,funasrTranscriptOutput,funasrDialogueOutput} from './apps/server/src/funasr-contract.ts';
import {transcriptSchema,diarizationSchema} from '@mote/shared';
import assert from 'node:assert/strict';
const chunks=[]; for await (const part of process.stdin) chunks.push(part);
const b=JSON.parse(Buffer.concat(chunks));
const request=parseFunasrRequest(b.request),diarizeRequest=parseFunasrRequest(b.diarizeRequest);
const raw=parseFunasrResponse(b.response,request),speakers=parseFunasrResponse(b.diarizeResponse,diarizeRequest);
const registry=new FileOutputRegistry();registry.register(funasrTranscriptOutput);registry.register(funasrDialogueOutput);
const transcript=transcriptSchema.parse(registry.decode(funasrTranscriptOutput,JSON.parse(b.response)).transcript);
const dialogue=transcriptSchema.parse(registry.decode(funasrDialogueOutput,JSON.parse(b.diarizeResponse)).transcript);
const acoustic=diarizationSchema.parse(projectFunasrDiarization(parseFunasrArchive(raw.checkpoint),speakers.diarization));
assert.deepEqual(transcript.segments.map(s=>[s.startMs,s.endMs,s.text]),[[1000,1500,'合成原文。'],[3000,4000,'尾段。']]);
assert.deepEqual(dialogue.segments.map(s=>s.speaker),['SPEAKER_0','SPEAKER_7']);
assert.equal(acoustic.observedSpeakers,2); assert.equal(acoustic.samples.length,2);
assert.equal(speakers.checkpoint.json,raw.checkpoint.json);
console.log('actual engine bytes -> FileOutputRegistry / Transcript / Diarization: passed');
"""
        result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', code],
                                cwd=Path(__file__).resolve().parents[1], input=contract.serialize(bundle),
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('passed', result.stdout)


class MappingAndRuntime(unittest.TestCase):
    def test_decoder_generation_limit_is_a_failure_until_eos_is_proven(self):
        class Llm:
            generation_config = SimpleNamespace(eos_token_id=[20, 21])
            output = [[10, 11, 12]]
            def generate(self, **_kwargs):
                return SimpleNamespace(tolist=lambda: self.output)
        llm = Llm()
        original_generate = llm.generate
        runtime = engine.SdkRuntime.__new__(engine.SdkRuntime)
        runtime.backend, runtime.threads, runtime.active = 'cpu', 1, None
        runtime.auto_model = lambda **kwargs: SimpleNamespace(kwargs=kwargs, model=SimpleNamespace(llm=llm))
        with runtime.component('asr', '.') as model:
            with self.assertRaisesRegex(engine.EngineError, 'output_limit'):
                model.model.llm.generate(max_new_tokens=3)
            llm.output = [[10, 11, 20]]
            self.assertEqual(model.model.llm.generate(max_new_tokens=3).tolist(), llm.output)
            llm.output = [[10, 11]]
            self.assertEqual(model.model.llm.generate(max_new_tokens=3).tolist(), llm.output)
        self.assertEqual(llm.generate, original_generate)
        self.assertIsNone(runtime.active)

    def test_cluster_adapter_passes_the_actual_sdk_class_constructor_and_call_arguments(self):
        calls = []
        def external_class(name):
            def init(**kwargs):
                def cluster(array, **options):
                    calls.append((name, kwargs, options, array))
                    return SimpleNamespace(tolist=lambda: [0, 1, 1])
                return cluster
            return init
        classes = SimpleNamespace(**{name: external_class(name) for name in ('ClusterBackend', 'SpectralCluster', 'KMeansCluster')})
        modules = {'funasr.models.campplus': SimpleNamespace(cluster_backend=classes)}
        runtime = engine.SdkRuntime.__new__(engine.SdkRuntime)
        runtime.np = SimpleNamespace(concatenate=lambda arrays, axis: [a[0] for a in arrays])
        vectors = [[[1, 0]], [[0, 1]], [[.1, 1]]]
        with patch.dict(sys.modules, modules):
            for options, count in [({'mode': 'unknown'}, 3), ({'mode': 'range', 'min': 2, 'max': 4}, 3), ({'mode': 'exact', 'count': 2}, 2048)]:
                runtime.cluster(vectors, contract.speaker_clustering_plan(options, count))
        self.assertEqual(calls, [
            ('ClusterBackend', {'max_num_spks': 16}, {'oracle_num': None}, [[1, 0], [0, 1], [.1, 1]]),
            ('SpectralCluster', {'min_num_spks': 2, 'max_num_spks': 2}, {'oracle_num': None}, [[1, 0], [0, 1], [.1, 1]]),
            ('KMeansCluster', {}, {'num_clusters': 2}, [[1, 0], [0, 1], [.1, 1]])])

    def test_sv_chunk_geometry_keeps_original_gaps_and_pads_but_never_drops_tail(self):
        pcm = b'\1\0' * 64001
        windows = engine.speaker_windows([{'startMs': 1000, 'endMs': 1100}, {'startMs': 2000, 'endMs': 4000.0625}], pcm)
        self.assertEqual([(a, b) for a, b, _ in windows], [(16000, 17600), (32000, 56000), (40001, 64001)])
        self.assertTrue(all(len(data) == 48000 for _, _, data in windows))
        self.assertEqual(windows[0][2][:3200], b'\1\0'*1600)
        self.assertEqual(windows[0][2][3200:], b'\0'*44800)
        self.assertEqual(windows[-1][2][-2:], b'\1\0')

    def test_short_noise_sparse_and_overlapping_labels_are_not_smoothed_into_people(self):
        windows = [(0, 8000, b''), (8000, 8016, b''), (8016, 8020, b''), (16000, 32000, b'')]
        rows = engine.acoustic_segments(windows, [9, 99999, -1, None])
        self.assertEqual([row['speaker'] for row in rows], [9, 99999, None, None])
        self.assertEqual(rows[1]['endMs']-rows[1]['startMs'], 1)
        self.assertEqual(rows[2]['endMs']-rows[2]['startMs'], .25)
        cp = {'sentences': [{'text': '重叠', 'startMs': 0, 'endMs': 1000}, {'text': '无归属', 'startMs': 2000, 'endMs': 3000}]}
        acoustics = [{'speaker': 7, 'startMs': 0, 'endMs': 700}, {'speaker': 8, 'startMs': 100, 'endMs': 200}]
        self.assertEqual([s['spk'] for s in engine.assign_sentences(cp, acoustics)], [7, None])
        self.assertEqual(len(acoustics), 2)

    def test_sdk_factory_loads_local_paths_only_and_releases_mps_tensor_owners(self):
        released, wrappers, tensors = [], [], []
        class Tensor:
            pass
        class Model:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.model = Tensor()
                self.model.llm = SimpleNamespace(generate=lambda **_kwargs: None)
                tensors.append(weakref.ref(self.model))
                wrappers.append(self)
        runtime = engine.SdkRuntime.__new__(engine.SdkRuntime)
        runtime.backend, runtime.threads, runtime.active = 'mps', 2, None
        runtime.auto_model = Model
        runtime.torch = SimpleNamespace(mps=SimpleNamespace(synchronize=lambda: released.append('sync'), empty_cache=lambda: released.append('empty')))
        with tempfile.TemporaryDirectory() as directory:
            for role in contract.MODEL_IDS:
                with self.subTest(role=role):
                    with self.assertRaisesRegex(RuntimeError, 'generated error'):
                        with runtime.component(role, directory) as model:
                            self.assertEqual(model.kwargs['model'], str(Path(directory).resolve()))
                            self.assertNotIn('spk_model', model.kwargs)
                            self.assertFalse(model.kwargs['trust_remote_code'])
                            self.assertTrue(model.kwargs['disable_update'])
                            self.assertEqual(model.kwargs['device'], 'mps')
                            self.assertEqual(model.kwargs['ncpu'], 2)
                            if role == 'vad':
                                # A top-level model_conf would make AutoModel skip
                                # local config loading and leave model as a path.
                                self.assertNotIn('model_conf', model.kwargs)
                                self.assertEqual(model.kwargs['max_single_segment_time'], engine.SETTINGS['maxSegmentMs'])
                            raise RuntimeError('generated error')
                    self.assertIsNone(runtime.active)
        self.assertTrue(all(ref() is None for ref in tensors))
        self.assertEqual(len(released), 8)
        self.assertEqual(wrappers[0].kwargs['llm_conf']['llm_dtype'], 'fp32')

    def test_manifest_has_all_local_components_and_immutable_download_identities(self):
        manifest = engine.asset_manifest()
        self.assertEqual(set(manifest), set(contract.MODEL_IDS))
        self.assertEqual(sum(len(m['files']) for m in manifest.values()), 23)
        for role, data in manifest.items():
            self.assertEqual(data['directory'], 'dialogue/'+role)
            self.assertEqual(data['id'], contract.MODEL_IDS[role])
            self.assertRegex(data['revision'], '^[a-f0-9]{40}$')
            self.assertEqual(data['license'], 'Apache-2.0')
            self.assertEqual(data['manifestSha256'], hashlib.sha256(contract.serialize(engine.component_manifest(role)).encode()).hexdigest())
            for item in data['files']:
                self.assertIn(data['revision'], item['url'])
                self.assertGreater(item['size'], 0)
                self.assertRegex(item['sha256'], '^[a-f0-9]{64}$')
                self.assertNotIn('..', Path(item['name']).parts)
        self.assertIn('Qwen3-0.6B/tokenizer.json', [f['name'] for f in manifest['asr']['files']])
        self.assertIn('jieba_usr_dict', [f['name'] for f in manifest['punctuation']['files']])

    def test_installed_dependencies_and_sdk_source_must_match_the_lock(self):
        names = {}
        for line in Path(engine.__file__).with_name('requirements-audio.txt').read_text().splitlines():
            item = line.split(';', 1)[0].strip()
            if '==' in item and not item.startswith('#'):
                name, version = item.split('==', 1)
                names[name] = version
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code = root/'funasr'/'generated.py'
            code.parent.mkdir()
            code.write_text('generated inert SDK file')
            expected = {'generated.py': hashlib.sha256(code.read_bytes()).hexdigest()}
            distribution = SimpleNamespace(locate_file=lambda relative: root/relative)
            with patch.object(engine, 'SDK_SOURCES', expected), patch.object(engine.importlib.metadata, 'version', side_effect=names.__getitem__), patch.object(engine.importlib.metadata, 'distribution', return_value=distribution):
                versions = engine.inspect_dependencies()
                self.assertEqual(versions['torch'], '2.8.0+cpu')
                code.write_text('altered SDK source')
                with self.assertRaisesRegex(engine.EngineError, 'component_missing'):
                    engine.inspect_dependencies()
            with patch.object(engine.importlib.metadata, 'version', side_effect=engine.importlib.metadata.PackageNotFoundError):
                with self.assertRaisesRegex(engine.EngineError, 'component_missing'):
                    engine.inspect_dependencies()


if __name__ == '__main__':
    if sys.argv[1:] == ['--emit']:
        print(contract.serialize(generated_bundle()))
    else:
        unittest.main()
