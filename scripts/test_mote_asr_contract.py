"""Generated contract evidence only. --emit feeds production Python bytes to TS."""
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

import mote_asr_contract as contract


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def generated_identity():
    return {'sdkVersion': contract.SDK_VERSION, 'sdkWheelSha256': contract.SDK_WHEEL_SHA256,
            **copy.deepcopy(contract.PINS), 'settingsFingerprint': sha('generated extract settings'),
            'models': {role: {'id': model, 'revision': sha('generated revision '+role),
                              'manifestSha256': sha('generated manifest '+role)}
                       for role, model in contract.MODEL_IDS.items()},
            'dependencies': {'torch': '2.10.0', 'numpy': '2.2.0'}, 'backend': 'cpu', 'threads': 1}


def generated_source(duration=1000):
    pcm = b'\0\0'*int(duration*16)
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(pcm)
    return {'audioSha256': hashlib.sha256(buffer.getvalue()).hexdigest(),
            'pcmSha256': hashlib.sha256(pcm).hexdigest(), 'sampleRate': 16000,
            'sampleCount': duration*16, 'durationMs': duration, 'timeline': 'original'}


def generated_preview():
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b'\0\0'*320)
    return base64.b64encode(buffer.getvalue()).decode()


def generated_bundle():
    source = generated_source()
    request = {'protocol': contract.PROTOCOL, 'operation': 'recognize',
               'audioSha256': source['audioSha256'], 'maxAudioMs': 1000, 'identity': generated_identity()}
    native = {'text': '  合成原文：零、二十、一百、一百零一、一千。\n尾段保留。  ',
              'sentence_info': [{'start': start, 'end': end, 'text': text}
                                for start, end, text in [(0, 20, '零到二十。'), (20, 100, '二十到一百。'),
                                                         (100, 101, '一百到一百零一。'), (101, 1000, '一百零一到一千。'),
                                                         (900, 1000, '重叠的尾段。')]]}
    response = contract.recognize_to_checkpoint(request, source, request['identity'], {'value': [[0, 1000]]}, native, [{'text': native['text']}])
    archive = json.loads(response)['checkpoint']
    diarize_request = {**request, 'operation': 'diarize', 'checkpoint': archive, 'speakers': {'mode': 'unknown'}}
    native_speakers = copy.deepcopy(native['sentence_info'])
    for index, label in [(0, 0), (1, 0), (3, 1), (4, 1)]:
        native_speakers[index]['spk'] = label
    result = contract.speakers_from_sdk(contract.read_checkpoint(archive), diarize_request['speakers'], native_speakers,
        [[0, .101, 0], [.101, 1, 1], [.9, .95, None]],
        [{'speaker': 0, 'startMs': 0, 'endMs': 20, 'wavBase64': generated_preview()},
         {'speaker': 1, 'startMs': 900, 'endMs': 920, 'wavBase64': generated_preview()}])
    diarize_response = contract.diarize_from_checkpoint(diarize_request, source, request['identity'], lambda cp, options: result)
    empty = []
    for duration in (0, 1000):
        silent_source = generated_source(duration)
        silent_request = {**request, 'audioSha256': silent_source['audioSha256']}
        silent_response = contract.recognize_to_checkpoint(silent_request, silent_source, request['identity'], {'value': []}, {'text': '', 'timestamp': []}, [])
        silent_diarize_request = {**silent_request, 'operation': 'diarize', 'checkpoint': json.loads(silent_response)['checkpoint'], 'speakers': {'mode': 'unknown'}}
        silent_diarize_response = contract.diarize_from_checkpoint(silent_diarize_request, silent_source, request['identity'],
            lambda cp, options: {'timeUnit': 'ms', 'speakers': options, 'assignments': [], 'segments': [], 'samples': []})
        empty.append({'request': silent_request, 'response': silent_response, 'diarizeRequest': silent_diarize_request, 'diarizeResponse': silent_diarize_response})
    return {'protocol': contract.PROTOCOL, 'sdkVersion': contract.SDK_VERSION, 'sdkWheelSha256': contract.SDK_WHEEL_SHA256,
            'pins': contract.PINS, 'limits': contract.LIMITS, 'modelIds': contract.MODEL_IDS,
            'request': request, 'source': source, 'native': native, 'response': response,
            'diarizeRequest': diarize_request, 'diarizeResponse': diarize_response, 'empty': empty,
            'failures': [contract.worker_failure('diarize', code) for code in contract.FAILURES]}


class AsrContract(unittest.TestCase):
    def setUp(self):
        self.bundle = generated_bundle()
        self.cp = contract.read_checkpoint(json.loads(self.bundle['response'])['checkpoint'])

    def test_fixed_millisecond_boundaries_overlap_and_tail_are_preserved(self):
        self.assertEqual([(s['startMs'], s['endMs']) for s in self.cp['sentences']],
                         [(0, 20), (20, 100), (100, 101), (101, 1000), (900, 1000)])
        self.assertEqual(self.cp['text'], self.bundle['native']['text'])
        self.assertEqual([s['text'] for s in self.cp['sentences']], [s['text'] for s in self.bundle['native']['sentence_info']])
        self.assertTrue(all('words' not in s for s in self.cp['sentences']))

    def test_sdk_text_is_required_and_alias_cannot_mask_a_missing_field(self):
        for native in [{'sentence': '错误别名'}, {'text': '有原文', 'sentence_info': []},
                       {'text': '有原文', 'sentence_info': [{'start': 0, 'end': 20, 'sentence': '错误别名'}]},
                       {'text': '有原文', 'sentence_info': [{'start': 0, 'end': 20, 'text': '原文', 'sentence': '另一个原文'}]}]:
            with self.subTest(native=native), self.assertRaises(contract.ContractError):
                contract.checkpoint_from_sdk(self.bundle['source'], self.bundle['request']['identity'], {'value': [[0, 1000]]}, native, [{'text': '合成识别块'}], 'sentence')
        alias = copy.deepcopy(self.bundle['native'])
        alias['sentence_info'][0]['sentence'] = alias['sentence_info'][0]['text']
        self.assertEqual(contract.checkpoint_from_sdk(self.bundle['source'], self.bundle['request']['identity'], {'value': [[0, 1000]]}, alias, [{'text': alias['text']}], 'vad')['sentences'][0]['precision'], 'vad')
        with self.assertRaisesRegex(contract.ContractError, 'Incomplete VAD recognition'):
            contract.checkpoint_from_sdk(self.bundle['source'], self.bundle['request']['identity'], {'value': [[0, 500], [500, 1000]]}, alias, [{'text': '只有第一块'}], 'sentence')

    def test_silence_is_complete_at_zero_and_nonzero_duration(self):
        for fixture in self.bundle['empty']:
            response = contract.parse_response(fixture['response'], fixture['request'])
            cp = contract.read_checkpoint(response['checkpoint'])
            self.assertEqual(cp['sentences'], [])
            self.assertEqual(cp['source']['durationMs'], cp['source']['sampleCount']/16)
            self.assertEqual(contract.parse_response(fixture['diarizeResponse'], fixture['diarizeRequest'])['diarization']['assignments'], [])

    def test_invalid_timelines_and_nonfinite_values_fail_instead_of_clipping(self):
        mutations = [lambda cp: cp['sentences'][0].update(startMs=21),
                     lambda cp: cp['sentences'][2].update(startMs=19),
                     lambda cp: cp['sentences'][-1].update(endMs=1001),
                     lambda cp: cp['sentences'][0].update(startMs=-1),
                     lambda cp: cp['vad'][0].update(endMs=0),
                     lambda cp: cp.update(complete=False),
                     lambda cp: cp.update(timeUnit='s'),
                     lambda cp: cp.update(recognitionChunks=[]),
                     lambda cp: cp['source'].update(sampleCount=1)]
        for value in (float('nan'), float('inf'), -float('inf')):
            mutations.append(lambda cp, value=value: cp['sentences'][0].update(endMs=value))
        for index, mutate in enumerate(mutations):
            cp = copy.deepcopy(self.cp)
            mutate(cp)
            with self.subTest(index=index), self.assertRaises(contract.ContractError):
                contract.archive_checkpoint(cp)

    def test_large_messages_and_row_counts_are_rejected_without_truncation(self):
        for key, limit in [('sentences', contract.LIMITS['sentences']), ('vad', contract.LIMITS['vad'])]:
            cp = copy.deepcopy(self.cp)
            cp[key] = [cp[key][0]]*(limit+1)
            with self.subTest(key=key), self.assertRaises(contract.ContractError):
                contract.archive_checkpoint(cp)
        cp = copy.deepcopy(self.cp)
        cp['text'] = '中'*(contract.LIMITS['textBytes']//3+1)
        with self.assertRaises(contract.ContractError):
            contract.archive_checkpoint(cp)
        with self.assertRaises(contract.ContractError):
            contract.read_checkpoint({'sha256': sha(''), 'json': ' '*(contract.LIMITS['checkpointBytes']+1)})
        with self.assertRaises(contract.ContractError):
            contract.parse_request(' '*(contract.LIMITS['wireBytes']+1))
        response = json.loads(self.bundle['diarizeResponse'])
        response['diarization']['segments'] = [response['diarization']['segments'][0]]*(contract.LIMITS['acousticSegments']+1)
        with self.assertRaises(contract.ContractError):
            contract.parse_response(response)
        with self.assertRaises((UnicodeError, ValueError)):
            contract.parse_response(self.bundle['response'].encode('utf-16'))

    def test_restart_uses_archived_bytes_and_changed_hashes_or_pins_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix='mote-asr-contract-test-') as directory:
            path = Path(directory)/'checkpoint.json'
            path.write_text(contract.serialize(json.loads(self.bundle['response'])['checkpoint']), encoding='utf-8')
            result = subprocess.run([sys.executable, '-c',
                'import json,sys; from mote_asr_contract import read_checkpoint,serialize; print(serialize(read_checkpoint(json.load(open(sys.argv[1])))))', str(path)],
                cwd=Path(__file__).parent, check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(result.stdout), self.cp)
        archive = json.loads(self.bundle['response'])['checkpoint']
        with self.assertRaises(contract.ContractError):
            contract.read_checkpoint({**archive, 'json': archive['json']+' '})
        for key in ['audioSha256', 'identity']:
            expected = copy.deepcopy(self.bundle['request'])
            if key == 'audioSha256':
                expected[key] = sha('another original')
            else:
                expected[key]['models']['asr']['manifestSha256'] = sha('another model')
            with self.subTest(key=key), self.assertRaises(contract.ContractError):
                contract.read_checkpoint(archive, expected)
        cp = copy.deepcopy(self.cp)
        cp['identity']['extract']['version'] = '4'
        with self.assertRaises(contract.ContractError):
            contract.archive_checkpoint(cp)

    def test_diarize_is_a_separate_cam_only_boundary_and_preserves_missing_speakers(self):
        calls = []
        def cam(cp, options):
            calls.append((cp, options))
            cp['sentences'][0]['text'] = 'model mutation cannot alter the archive'
            return json.loads(self.bundle['diarizeResponse'])['diarization']
        response = contract.parse_response(contract.diarize_from_checkpoint(self.bundle['diarizeRequest'], self.bundle['source'], self.cp['identity'], cam))
        self.assertEqual(len(calls), 1)
        self.assertEqual(contract.read_checkpoint(response['checkpoint']), self.cp)
        self.assertIsNone(response['diarization']['assignments'][2])
        altered = {**self.bundle['source'], 'pcmSha256': sha('different PCM')}
        with self.assertRaises(contract.ContractError):
            contract.diarize_from_checkpoint(self.bundle['diarizeRequest'], altered, self.cp['identity'], cam)
        self.assertEqual(len(calls), 1)
        actual_identity = copy.deepcopy(self.cp['identity'])
        actual_identity['models']['speaker']['manifestSha256'] = sha('unexpected installed CAM++')
        with self.assertRaisesRegex(contract.ContractError, 'Worker model/settings identity'):
            contract.diarize_from_checkpoint(self.bundle['diarizeRequest'], self.bundle['source'], actual_identity, cam)
        with self.assertRaisesRegex(contract.ContractError, 'Pinned model/settings identity'):
            contract.recognize_to_checkpoint(self.bundle['request'], self.bundle['source'], actual_identity, {'value': [[0, 1000]]}, self.bundle['native'], [{'text': self.bundle['native']['text']}])
        self.assertEqual(len(calls), 1)

    def test_cancellation_before_and_during_cam_cannot_publish_a_success(self):
        calls = []
        def cam(cp, options):
            calls.append(True)
            return json.loads(self.bundle['diarizeResponse'])['diarization']
        with self.assertRaisesRegex(contract.ContractError, 'Cancelled before'):
            contract.diarize_from_checkpoint(self.bundle['diarizeRequest'], self.bundle['source'], self.cp['identity'], cam, lambda: True)
        self.assertEqual(calls, [])
        with self.assertRaisesRegex(contract.ContractError, 'Cancelled during'):
            contract.diarize_from_checkpoint(self.bundle['diarizeRequest'], self.bundle['source'], self.cp['identity'], cam, lambda: bool(calls))
        self.assertEqual(calls, [True])
        self.assertEqual(contract.read_checkpoint(self.bundle['diarizeRequest']['checkpoint']), self.cp)

    def test_sdk_missing_none_and_noise_speakers_stay_unknown_and_no_overlap_does_not_default_to_zero(self):
        native = copy.deepcopy(self.bundle['native']['sentence_info'])
        native[0]['spk'] = None
        native[1]['spk'] = -1
        native[3]['spk'] = 0  # SDK's no-overlap default is not speaker evidence.
        result = contract.speakers_from_sdk(self.cp, {'mode': 'unknown'}, native, [[0, .1, 0]], [])
        self.assertEqual(result['assignments'], [None]*5)
        self.assertEqual(result['segments'][0]['endMs'], 100)
        native[0]['text'] = 'changed by a later stage'
        with self.assertRaisesRegex(contract.ContractError, 'changed recognition'):
            contract.speakers_from_sdk(self.cp, {'mode': 'unknown'}, native, [[0, .1, 0]], [])

    def test_speaker_modes_use_real_sdk_arguments_without_the_short_input_bypass(self):
        self.assertEqual(contract.speaker_clustering_plan({'mode': 'unknown'}, 10)['class'], 'ClusterBackend')
        for options in [{'mode': 'exact', 'count': 2}, {'mode': 'range', 'min': 2, 'max': 4}]:
            plan = contract.speaker_clustering_plan(options, 10)
            self.assertEqual(plan['class'], 'SpectralCluster')
            self.assertEqual(plan['init']['min_num_spks'], 2)
        self.assertEqual(contract.speaker_clustering_plan({'mode': 'exact', 'count': 2}, 2048),
                         {'class': 'KMeansCluster', 'init': {}, 'call': {'num_clusters': 2}})
        self.assertEqual(contract.speaker_clustering_plan({'mode': 'range', 'min': 2, 'max': 4}, 3)['init']['max_num_spks'], 2)
        with self.assertRaisesRegex(contract.ContractError, 'constraint_unsatisfied'):
            contract.speaker_clustering_plan({'mode': 'exact', 'count': 2}, 1)
        for options in [{'mode': 'range', 'min': 4, 'max': 2}, {'mode': 'exact', 'count': True},
                        {'mode': 'unknown', 'count': 2}, {'mode': 'exact', 'count': 17}]:
            with self.subTest(options=options), self.assertRaises(contract.ContractError):
                contract.validate_speakers(options)

    def test_all_failure_states_are_explicit_and_partial_success_is_rejected(self):
        for data in self.bundle['failures']:
            failure = contract.parse_response(data)
            self.assertEqual((failure['status'], failure['execution']), contract.FAILURES[failure['code']])
        response = json.loads(self.bundle['diarizeResponse'])
        response['diarization']['assignments'].pop()
        with self.assertRaises(contract.ContractError):
            contract.parse_response(response)
        failure = json.loads(contract.worker_failure('recognize', 'response_unknown'))
        failure['status'] = 'cancelled'
        with self.assertRaises(contract.ContractError):
            contract.parse_response(failure)


if __name__ == '__main__':
    if sys.argv[1:] == ['--emit']:
        print(contract.serialize(generated_bundle()))
    else:
        unittest.main()
