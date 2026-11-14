"""Real ASR HTTP/process/facts boundaries with generated audio and model objects.

The FunASR model module is replaced at its published Python entrypoints;
FFmpeg, multipart, hashing, current serializers, HTTP, receipts and TS consumers
remain real. No model dependencies, weights or personal profiles are needed.
"""
from concurrent.futures import ThreadPoolExecutor
import base64
import copy
import hashlib
import http.client
import io
import json
import math
import os
from pathlib import Path
import shutil
import signal
import select
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
import wave

import mote_asr_contract as contract

ROOT = Path(__file__).resolve().parent.parent
TOKEN = 'generated-asr02-token-for-private-worker'
SCOPE = hashlib.sha256(b'generated asr02 request scope').hexdigest()
TEXT = '生成录音的完整尾段。'

# Only the unavailable engine/model boundary is generated. Its public API is the
# ASR-01 handoff: component_manifest / verify_models / SdkRuntime / run_audio.
ENGINE = r'''
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import wave
import mote_asr_contract as contract
from mote_audio import normalize
ROOT = Path(__file__).parent
SETTINGS_FINGERPRINT = hashlib.sha256(b'generated asr02 settings').hexdigest()
VERSIONS = {'funasr': contract.SDK_VERSION, 'torch': '2.8.0', 'numpy': '2.2.6'}
ASSET = b'Generated ASR-02 model boundary. No weights.'
class EngineError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__('generated private diagnostic that must not reach logs')
def component_manifest(role):
    return {'id': contract.MODEL_IDS[role], 'revision': hashlib.sha256(('generated-'+role).encode()).hexdigest(),
            'files': [{'name': 'model.bin', 'size': len(ASSET), 'sha256': hashlib.sha256(ASSET).hexdigest()}]}
def verify_models(root):
    result = {}
    for role in contract.MODEL_IDS:
        manifest = component_manifest(role)
        try:
            if (Path(root)/role/'model.bin').read_bytes() != ASSET:
                raise EngineError('model_missing')
        except OSError:
            raise EngineError('model_missing')
        result[role] = {'id': manifest['id'], 'revision': manifest['revision'],
                        'manifestSha256': hashlib.sha256(contract.serialize(manifest).encode()).hexdigest()}
    return result
class SdkRuntime:
    def __init__(self, backend, threads):
        self.versions = VERSIONS
    @contextmanager
    def component(self, role, directory):
        (ROOT/('load-'+role)).write_text(str(os.getpid()))
        while (ROOT/'hold-load').exists():
            time.sleep(.01)
        if (ROOT/'fail-load').exists() or (ROOT/'fail-role').exists() and (ROOT/'fail-role').read_text() == role:
            raise EngineError('worker_not_ready')
        yield object()
    def close(self):
        pass
# An import gate controls accepted, before the child can ask to execute. Probe
# processes never see it: the fixture creates it only after health is ready.
if (ROOT/'hold-import').exists():
    (ROOT/'import-entered').write_text(str(os.getpid()))
    while (ROOT/'hold-import').exists():
        time.sleep(.01)
def run_audio(request, original, dialogue_directory, *, backend, threads, timeout, started_at):
    with (ROOT/'runs.jsonl').open('a') as log:
        log.write(json.dumps({'pid': os.getpid(), 'operation': request['operation'], 'path': str(original),
                              'budget': request['maxAudioMs'], 'timeout': timeout})+'\n')
    mode = (ROOT/'mode').read_text()
    if mode == 'ignore-term':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if mode in ('ffmpeg', 'crash-with-ffmpeg'):
        # Generated unavailable-process boundary, deliberately ignores TERM.
        code = "import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path('ffmpeg.pid').write_text(str(os.getpid()));time.sleep(30);Path('late').write_text('late')"
        subprocess.Popen([sys.executable, '-c', code], cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if mode == 'crash-with-ffmpeg':
            while not (ROOT/'ffmpeg.pid').exists():
                time.sleep(.005)
            os._exit(7)
    (ROOT/'entered').write_text(str(os.getpid()))
    if mode == 'network-check':
        if 'MOTE_MEDIA_WORKER_TOKEN' in os.environ:
            raise EngineError('inference_failed')
        try:
            socket.create_connection(('127.0.0.1', int((ROOT/'network-port').read_text())), timeout=.2)
        except OSError:
            (ROOT/'network-denied').touch()
        else:
            raise EngineError('inference_failed')
        print('Generated SDK diagnostic with private recording text')
        sys.stderr.write('Generated SDK diagnostic with private recording text')
    while (ROOT/'hold-run').exists() or mode == 'ffmpeg':
        time.sleep(.01)
    if (ROOT/'delay').exists():
        time.sleep(float((ROOT/'delay').read_text()))
    if mode.startswith('error:'):
        raise EngineError(mode.split(':', 1)[1])
    if mode == 'crash':
        os._exit(7)
    if mode == 'oversize':
        return ' '*(contract.LIMITS['wireBytes']+1)
    # The production shared audio primitive actually runs FFmpeg, preserving the
    # full duration and rejecting an over-budget normalized tail.
    wav = Path(original).with_name('normalized.wav')
    try:
        normalize(original, wav, request['maxAudioMs'], timeout)
    except OverflowError:
        raise EngineError('unsupported_input')
    with wave.open(str(wav), 'rb') as reader:
        pcm = reader.readframes(reader.getnframes())
    source = {'audioSha256': hashlib.sha256(Path(original).read_bytes()).hexdigest(),
              'pcmSha256': hashlib.sha256(pcm).hexdigest(), 'sampleCount': len(pcm)//2,
              'sampleRate': 16000, 'durationMs': len(pcm)/32, 'timeline': 'original'}
    if request['operation'] == 'recognize':
        if mode == 'partial':
            source['durationMs'] += 1  # A seemingly complete but invalid output.
        text = '' if mode == 'silence' else '生成录音的完整尾段。'
        native = {'text': text, 'sentence_info': [{'start': 0, 'end': source['durationMs'], 'text': text}] if text else []}
        return contract.recognize_to_checkpoint(request, source, request['identity'],
            {'value': [[0, source['durationMs']]] if text else []}, native, [{'text': text}] if text else [])
    def cam(cp, speakers):
        (ROOT/'cam-entered').write_text('generated')
        return {'timeUnit': 'ms', 'speakers': speakers, 'assignments': [0]*len(cp['sentences']),
                'segments': [{'startMs': 0, 'endMs': source['durationMs'], 'speaker': 0}] if cp['sentences'] else [], 'samples': []}
    return contract.diarize_from_checkpoint(request, source, request['identity'], cam)
'''


def until(check, label, timeout=10):
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.01)
    raise AssertionError('Generated ASR worker did not reach '+label)


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        # A reparented Linux zombie is dead, but init may not have reaped it yet.
        stat = Path('/proc')/str(pid)/'stat'
        return not stat.exists() or stat.read_text().split(') ', 1)[1][0] != 'Z'
    except ProcessLookupError:
        return False


def generated_audio(duration=1000, sample=0):
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(sample.to_bytes(2, 'little', signed=True)*int(duration*16))
    return output.getvalue()


def multipart(request, audio, boundary='generated-asr02-boundary', audio_first=False):
    parts = [('request', 'application/json', contract.serialize(request).encode()), ('audio', 'application/octet-stream', audio)]
    if audio_first:
        parts.reverse()
    body = b''
    for name, content, value in parts:
        body += ('--'+boundary+'\r\nContent-Disposition: form-data; name="'+name+'"\r\nContent-Type: '+content+'\r\n\r\n').encode()+value+b'\r\n'
    return body+('--'+boundary+'--\r\n').encode(), 'multipart/form-data; boundary='+boundary


class WorkerFixture:
    def __init__(self, timeout=3, max_audio_ms=86400000, token=TOKEN, install=True, load_timeout=5, request_timeout=12):
        self.temporary = tempfile.TemporaryDirectory(prefix='mote-asr02-test-')
        self.root = Path(self.temporary.name)
        self.models = self.root/'models/dialogue'
        self.scratch = self.root/'scratch'
        self.scratch.mkdir(mode=0o700)
        for name in ('transcription-server.py', 'mote_execution_facts.py', 'mote_asr_contract.py', 'mote_audio.py'):
            shutil.copyfile(ROOT/'scripts'/name, self.root/name)
        (self.root/'mote_funasr.py').write_text(ENGINE)
        (self.root/'mode').write_text('success')
        if install:
            self.install()
        self.timeout, self.max_audio_ms, self.token, self.load_timeout = timeout, max_audio_ms, token, load_timeout
        self.request_timeout = request_timeout
        self.child = None
        self.log = (self.root/'worker.log').open('wb')
        self.start()

    def install(self, roles=None):
        for role in roles or contract.MODEL_IDS:
            directory = self.models/role
            directory.mkdir(parents=True, exist_ok=True)
            (directory/'model.bin').write_bytes(b'Generated ASR-02 model boundary. No weights.')

    def start(self):
        env = {'PATH': getattr(self, 'path', os.environ['PATH']), 'HOME': str(self.root), 'TMPDIR': str(self.scratch),
               'PYTHONNOUSERSITE': '1', 'MOTE_MEDIA_WORKER_TOKEN': self.token}
        self.child = subprocess.Popen([sys.executable, str(self.root/'transcription-server.py'),
            '--model-root', str(self.models), '--port', '0', '--backend', 'cpu', '--threads', '1',
            '--timeout', str(self.timeout), '--load-timeout', str(self.load_timeout),
            '--max-audio-ms', str(self.max_audio_ms), '--temporary-root', str(self.scratch)],
            env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=self.log)
        readable = select.select([self.child.stdout], [], [], 10)[0]
        if not readable:
            self.stop()
            raise AssertionError('Worker did not open the generated listener')
        line = self.child.stdout.readline()
        if not line:
            raise AssertionError('Worker startup failed: '+(self.root/'worker.log').read_text())
        self.port = json.loads(line)['port']

    def stop(self, kind=signal.SIGTERM):
        if self.child is not None:
            if self.child.poll() is None:
                self.child.send_signal(kind)
            self.child.wait(timeout=12)
            self.child.stdout.close()
            self.child = None

    def close(self):
        try:
            self.stop()
        finally:
            self.log.close()
            self.temporary.cleanup()

    def http(self, method, path, body=None, headers=None, auth=True):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=self.request_timeout)
        fields = {'Authorization': 'Bearer '+self.token} if auth else {}
        fields.update(headers or {})
        try:
            connection.request(method, path, body=body, headers=fields)
            response = connection.getresponse()
            data = response.read()
            return response.status, dict((key.lower(), value) for key, value in response.getheaders()), data
        finally:
            connection.close()

    def health(self):
        return json.loads(self.http('GET', '/health')[2])

    def ready(self):
        return until(lambda: (h if h['asr'] else None) if (h := self.health()) else None, 'four-component loaded health')['identity']

    def request(self, audio=None, **changes):
        audio = generated_audio() if audio is None else audio
        identity = self.ready()
        return {'protocol': contract.PROTOCOL, 'operation': 'recognize',
                'audioSha256': hashlib.sha256(audio).hexdigest(), 'identity': identity,
                'maxAudioMs': 14400000, **changes}, audio

    def post(self, request, audio, request_id=None, extra=None, audio_first=False):
        body, content_type = multipart(request, audio, audio_first=audio_first)
        headers = {'Content-Type': content_type}
        if request_id is not None:
            headers.update({'X-Mote-Request-Id': request_id, 'X-Mote-Request-Scope': SCOPE})
        headers.update(extra or {})
        return self.http('POST', '/transcribe' if request['operation'] == 'recognize' else '/diarize', body, headers)

    def fact(self, request_id, scope=SCOPE):
        return json.loads(self.http('GET', '/executions/'+request_id, headers={'X-Mote-Request-Scope': scope})[2])

    def runs(self):
        path = self.root/'runs.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def raw(self, request, audio, request_id, partial=None):
        body, content_type = multipart(request, audio)
        header = ('POST /transcribe HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '+self.token+
                  '\r\nX-Mote-Request-Id: '+request_id+'\r\nX-Mote-Request-Scope: '+SCOPE+
                  '\r\nContent-Type: '+content_type+'\r\nContent-Length: '+str(len(body))+'\r\n\r\n').encode()
        stream = socket.create_connection(('127.0.0.1', self.port), timeout=5)
        stream.sendall(header+body[:partial] if partial is not None else header+body)
        return stream


@unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg is required for the production normalization boundary')
class TranscriptionHTTP(unittest.TestCase):
    def fixture(self, **kwargs):
        fixture = WorkerFixture(**kwargs)
        self.addCleanup(fixture.close)
        return fixture

    def response(self, result, request, code=None):
        status, headers, data = result
        self.assertEqual(headers.get('x-mote-execution'), 'local')
        response = contract.parse_response(data, request)
        if code:
            self.assertEqual(response['code'], code)
        else:
            self.assertEqual(status, 200)
            self.assertEqual(response['status'], 'succeeded')
        return response

    def test_directory_only_partial_install_and_failed_load_never_report_ready_and_control_recovers(self):
        f = self.fixture(install=False)
        self.assertEqual(f.http('GET', '/health', auth=False)[0], 401)
        for role in contract.MODEL_IDS:
            (f.models/role).mkdir(parents=True)
        self.assertFalse(f.health()['asr'])
        f.install(['asr', 'vad', 'speaker'])
        self.assertFalse(f.health()['diarization'])
        request = {'protocol': contract.PROTOCOL, 'operation': 'recognize'}
        missing = self.response(f.post(request, generated_audio(), str(uuid.uuid4())), None, 'model_missing')
        self.assertEqual(missing['execution'], 'not_started')
        self.assertEqual(f.runs(), [])
        f.install(['punctuation'])
        (f.root/'fail-role').write_text('punctuation')
        f.health()
        until(lambda: (f.root/'load-asr').exists() and not f.health()['loading'], 'failed actual load')
        self.assertFalse(f.health()['asr'])
        result = f.post(request, generated_audio())
        self.response(result, None, 'worker_not_ready')
        self.assertEqual(result[1].get('x-mote-execution-started'), 'false')
        (f.root/'fail-role').unlink()
        f.install(['punctuation'])  # Changed installation invalidates failed probe.
        identity = f.ready()
        self.assertEqual(set(identity['models']), set(contract.MODEL_IDS))
        for role in contract.MODEL_IDS:
            self.assertTrue((f.root/('load-'+role)).exists())
        (f.models/'vad/model.bin').write_bytes(b'damaged bytes')
        self.assertFalse(f.health()['asr'])
        f.install(['vad'])
        f.ready()

    def test_control_endpoints_remain_available_while_all_components_are_loading(self):
        f = self.fixture()
        (f.root/'hold-load').touch()
        self.assertFalse(f.health()['asr'])
        until(lambda: (f.root/'load-asr').exists(), 'blocked loader')
        self.assertTrue(f.health()['loading'])
        request_id = str(uuid.uuid4())
        self.assertEqual(f.fact(request_id)['outcome'], 'receipt_unavailable')
        result = f.post({'operation': 'recognize'}, generated_audio(), request_id)
        self.response(result, None, 'worker_not_ready')
        self.assertEqual(result[1]['x-mote-execution-started'], 'false')
        self.assertEqual(f.runs(), [])
        (f.root/'hold-load').unlink()
        f.ready()

    def test_missing_engine_is_unstarted_without_loading_old_audio_runtime(self):
        f = self.fixture()
        f.stop()
        (f.root/'mote_funasr.py').unlink()
        f.start()
        health = f.health()
        self.assertFalse(health['asr'])
        self.assertIn('funasr', health['missingDependencies'])
        request_id = str(uuid.uuid4())
        result = f.post({'operation': 'recognize'}, generated_audio(), request_id)
        self.response(result, None, 'component_missing')
        self.assertEqual(result[1]['x-mote-execution-started'], 'false')
        self.assertEqual(f.fact(request_id)['outcome'], 'receipt_unavailable')
        self.assertEqual(f.runs(), [])
        (f.root/'mote_funasr.py').write_text(ENGINE)
        f.ready()

    def test_ffmpeg_disappearance_blocks_execution_without_claiming_funasr_packages_are_missing(self):
        f = self.fixture()
        f.stop()
        binary = f.root/'bin'
        binary.mkdir()
        executable = binary/'ffmpeg'
        executable.symlink_to(shutil.which('ffmpeg'))
        f.path = str(binary)
        f.start()
        request, audio = f.request()
        executable.unlink()
        health = f.health()
        self.assertFalse(health['asr'])
        self.assertFalse(health['diarization'])
        self.assertEqual(health['missingDependencies'], ['ffmpeg'])
        result = f.post(request, audio)
        self.response(result, request, 'component_missing')
        self.assertEqual(result[1]['x-mote-execution-started'], 'false')
        self.assertEqual(f.runs(), [])
        executable.symlink_to(shutil.which('ffmpeg'))
        self.response(f.post(request, audio), request)

    def test_inference_child_stays_offline_and_cannot_log_recordings_or_inherit_http_token(self):
        f = self.fixture()
        request, audio = f.request()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            listener.settimeout(.1)
            (f.root/'network-port').write_text(str(listener.getsockname()[1]))
            (f.root/'mode').write_text('network-check')
            self.response(f.post(request, audio), request)
            self.assertTrue((f.root/'network-denied').exists())
            with self.assertRaises(socket.timeout):
                listener.accept()
        self.assertNotIn('Generated SDK diagnostic', (f.root/'worker.log').read_text())

    def test_multipart_preserves_boundary_prefix_bytes_and_bounds_json_before_decoding(self):
        f = self.fixture()
        audio = bytearray(generated_audio())
        prefix = b'\r\n--generated-asr02-boundaryX'
        audio[100:100+len(prefix)] = prefix
        request, audio = f.request(bytes(audio))
        body, content_type = multipart(request, audio)
        body = body.replace(b'Content-Disposition:', b'content-disposition:').replace(b'Content-Type:', b'content-type:')
        result = f.http('POST', '/transcribe', body, {'Content-Type': content_type})
        self.response(result, request)
        huge_request = b' '*(contract.LIMITS['wireBytes']+1)
        body = (b'--generated-asr02-boundary\r\nContent-Disposition: form-data; name="request"\r\n'
                b'Content-Type: application/json\r\n\r\n'+huge_request+
                b'\r\n--generated-asr02-boundary--\r\n')
        result = f.http('POST', '/transcribe', body, {'Content-Type': content_type})
        self.assertEqual(result[0], 413)
        self.assertEqual(result[1]['x-mote-execution-started'], 'false')
        self.assertEqual(len(f.runs()), 1)
        self.assertEqual(list(f.scratch.iterdir()), [])

    def test_real_http_two_stages_restart_and_python_bytes_reach_central_parsers_and_outputs(self):
        f = self.fixture()
        request, audio = f.request()
        request_id = str(uuid.uuid4())
        recognition_result = f.post(request, audio, request_id, audio_first=True)
        recognition = self.response(recognition_result, request)
        self.assertEqual(recognition_result[1]['x-mote-receipt-id'], request_id)
        cp = contract.read_checkpoint(recognition['checkpoint'], request)
        self.assertEqual(cp['text'], TEXT)
        self.assertEqual(cp['source']['durationMs'], 1000)
        self.assertEqual(f.fact(request_id)['state'], 'succeeded')
        self.assertEqual(f.fact(request_id, 'b'*64)['state'], 'unknown')
        f.stop()
        f.start()
        f.ready()
        diarize = {**request, 'operation': 'diarize', 'checkpoint': recognition['checkpoint'], 'speakers': {'mode': 'range', 'min': 1, 'max': 3}}
        result = f.post(diarize, audio, str(uuid.uuid4()))
        dialogue = self.response(result, diarize)
        self.assertEqual(dialogue['checkpoint'], recognition['checkpoint'])
        self.assertEqual([row['operation'] for row in f.runs()], ['recognize', 'diarize'])
        example = {'request': request, 'recognition': json.loads(recognition_result[2]), 'diarize': diarize, 'dialogue': json.loads(result[2]), 'health': f.health()}
        # Feed actual HTTP response bytes to the existing Central consumers and
        # FileOutputRegistry, including its rules for late/cancelled media facts.
        script = """
import {parseFunasrRequest,parseFunasrResponse,parseFunasrArchive,funasrTranscriptOutput,funasrDialogueOutput} from './apps/server/src/funasr-contract.ts';
import {FileOutputRegistry} from './apps/server/src/file-recipes.ts';
import {mediaModelHealth} from './apps/server/src/media-configuration.ts';
import assert from 'node:assert/strict';
const data=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>resolve(s));}));
const request=parseFunasrRequest(data.request),diarize=parseFunasrRequest(data.diarize);
const recognition=parseFunasrResponse(data.recognition,request),dialogue=parseFunasrResponse(data.dialogue,diarize);
const outputs=new FileOutputRegistry();outputs.register(funasrTranscriptOutput);outputs.register(funasrDialogueOutput);
const transcript=outputs.decode(funasrTranscriptOutput,recognition).transcript;
assert.equal(transcript.coverage,'full');assert.equal(transcript.segments[0].text,'生成录音的完整尾段。');
assert.equal(outputs.decode(funasrDialogueOutput,dialogue).transcript.segments[0].speaker,'SPEAKER_0');
assert.equal(dialogue.checkpoint.sha256,recognition.checkpoint.sha256);
assert.equal(mediaModelHealth('dialogue',data.health).ready,true);
assert.throws(()=>parseFunasrResponse(data.recognition,{...request,audioSha256:'f'.repeat(64)}));
assert.throws(()=>parseFunasrResponse(data.dialogue,{...diarize,checkpoint:{...diarize.checkpoint,sha256:'f'.repeat(64)}}));
"""
        checked = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', script], cwd=ROOT,
                                 input=json.dumps(example), capture_output=True, text=True, timeout=30)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        destination = os.environ.get('MOTE_ASR02_EXAMPLE_PATH')
        if destination:
            Path(destination).write_text(json.dumps(example, ensure_ascii=False, indent=2)+'\n')
        self.assertEqual(f.http('DELETE', '/executions/'+request_id, headers={'X-Mote-Request-Scope': SCOPE})[0], 200)
        self.assertEqual(f.fact(request_id)['outcome'], 'receipt_unavailable')
        self.assertEqual(f.post(request, audio, request_id)[0], 409)
        self.assertEqual(len(f.runs()), 2, 'consumed identity never runs again after receipt deletion')
        saved = (f.root/'models/execution-facts/asr.sqlite').read_bytes()
        self.assertNotIn(TEXT.encode(), saved)
        self.assertNotIn(TOKEN.encode(), saved)
        self.assertNotIn(str(f.root).encode(), saved)

    def test_busy_is_unstarted_no_failed_receipt_and_concurrent_audio_cannot_overwrite_input(self):
        f = self.fixture()
        request, audio = f.request()
        (f.root/'hold-run').touch()
        first_id, second_id = str(uuid.uuid4()), str(uuid.uuid4())
        with ThreadPoolExecutor(1) as executor:
            running = executor.submit(f.post, request, audio, first_id)
            until(lambda: (f.root/'entered').exists(), 'first inference')
            other_audio = generated_audio(sample=7)
            other = {**request, 'audioSha256': hashlib.sha256(other_audio).hexdigest()}
            result = f.post(other, other_audio, second_id)
            self.response(result, other, 'resource_busy')
            self.assertEqual(result[0], 429)
            self.assertEqual(result[1]['retry-after'], '5')
            self.assertEqual(result[1]['x-mote-execution-started'], 'false')
            self.assertEqual(f.fact(second_id)['outcome'], 'receipt_unavailable')
            self.assertEqual(f.fact(first_id)['state'], 'running')
            self.assertTrue(f.health()['asr'])
            original = Path(f.runs()[0]['path'])
            self.assertEqual(original.read_bytes(), audio)
            self.assertEqual(original.stat().st_mode & 0o777, 0o600)
            (f.root/'hold-run').unlink()
            self.response(running.result(timeout=10), request)
        self.response(f.post(other, other_audio, second_id), other)
        self.assertEqual(len({row['path'] for row in f.runs()}), 2)
        self.assertEqual(list(f.scratch.iterdir()), [])

    def test_central_refunds_unstarted_calls_and_rejects_late_http_success_after_cancel(self):
        f = self.fixture(timeout=10)
        identity = f.ready()
        (f.root/'hold-run').touch()
        # The generated provider adapter occupies the ASR-03 boundary. The HTTP
        # producer, current parser, Store, ingress commit, execution engine,
        # cancellation, artifact commit and chunk consumers are production code.
        script = r"""
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Store,sha256} from './apps/server/src/store.ts';
import {SourceStore} from './apps/server/src/sources.ts';
import {FileStore} from './apps/server/src/files.ts';
import {FileProcessing} from './apps/server/src/file-processing.ts';
import {ProviderFailure} from '@mote/shared';
import {fixtureFilePolicy} from './apps/server/test/fixtures/file-policy.ts';
import {requestLocalJson} from './apps/server/src/local-http.ts';
import {parseFunasrResponse,parseFunasrArchive,projectFunasrTranscript} from './apps/server/src/funasr-contract.ts';
const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>resolve(s));}));
const directory=await mkdtemp(join(tmpdir(),'mote-asr02-late-central-'));
const store=new Store(directory,{dataKey:'61'.repeat(32),contentEncryptionEnabled:true});
const sources=new SourceStore(store),files=new FileStore(store,sources);
let received,issued=0;
const provider={async transcribe(call){
 const chunks=[];for await(const chunk of call.body)chunks.push(chunk);const audio=Buffer.concat(chunks);
 const request={protocol:'mote.funasr/1',operation:'recognize',audioSha256:sha256(audio),maxAudioMs:call.maxAudioMs,identity:input.identity};
 const boundary='generated-central-asr02';
 const body=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(request)+'\r\n--'+boundary+'\r\nContent-Disposition: form-data; name="audio"\r\nContent-Type: application/octet-stream\r\n\r\n'),audio,Buffer.from('\r\n--'+boundary+'--\r\n')]);
 let raw;try{raw=await requestLocalJson(input.url,{method:'POST',headers:{Authorization:'Bearer '+input.token,'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':String(body.length),'X-Mote-Request-Id':call.request.requestId,'X-Mote-Request-Scope':call.request.requestScope},
 body:(async function*(){yield body;})(),signal:call.signal,requireOfflineExecution:true,
 onRequest:()=>{call.authorizeModel?.();call.request.onRequest();issued++;},
 onResponseHeaders:headers=>call.request.onExecutionFacts?.(headers['x-mote-receipt-id']===call.request.requestId)});
 }catch(error){
  // ASR-03 must retain this existing admission fact. The generic legacy
  // transport's 503 classification alone would charge a genuine failure.
  if(error instanceof ProviderFailure&&error.diagnostic?.httpStatus===503&&error.details.executionStarted===false)
   throw new ProviderFailure({...error.details,admissionWaiting:true});
  throw error;
 }
 received=parseFunasrResponse(raw,request);assert.equal(received.status,'succeeded');
 return projectFunasrTranscript(parseFunasrArchive(received.checkpoint,request));
}};
const processing=new FileProcessing(files,provider,undefined,{media:{asrEndpoint:input.url,workerToken:input.token}});
const until=async(check,label)=>{const deadline=Date.now()+10000;while(!await check()){assert.ok(Date.now()<deadline,label+' '+JSON.stringify(store.db.prepare('SELECT kind,state,error FROM execution_steps').all()));await delay(10);}};
try{
 await processing.runtime.ready;
 const settings={...processing.view().settings,enabled:true,summarize:false,localEndpoint:input.url,localWorkerApiKey:input.token,timeoutMs:10000};
 processing.update({revision:processing.view().revision,settings,policy:fixtureFilePolicy(settings,processing.runtime.registry)});
 sources.register({id:'generated-asr02',name:'Generated ASR-02',kind:'local-files',deviceId:'generated-device',platform:'import',retention:'archive'});
 const bytes=Buffer.from(input.audio,'base64');
 const manifest={sourceId:'generated-asr02',sizeBytes:bytes.length,sha256:sha256(bytes),item:{externalId:'generated.wav',revision:'1',observedAt:'2026-11-01T00:00:00Z',title:'Generated recording',kind:'file',layer:'original',mimeType:'audio/wav',text:'',deleted:false}};
 const upload=files.begin(manifest,()=>{});files.part(upload.uploadId,0,bytes,()=>{});const {id}=await files.commit(upload.uploadId,()=>{});
 if(input.rejection){
  await processing.tick();
  const step=store.db.prepare("SELECT state,attempts FROM file_steps WHERE capture_id=? AND step='extract'").get(id);
  assert.equal(issued,1);assert.equal(step.attempts,0,'an explicit unstarted worker response refunds recognition failure budget');
  assert.notEqual(step.state,'failed');assert.equal(files.detail(id).artifacts.length,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM media_execution_calls').get().n,0,'no ambiguous issued call remains after explicit unstarted rejection');
 }else{
 const original=JSON.stringify(files.version(id)),running=processing.tick();
 await until(()=>readFile(join(input.workerRoot,'entered')).then(()=>true,()=>false),'real worker entered inference');
 assert.equal(processing.cancel(id).state,'cancelled');await running;
 assert.equal(processing.cancellation(id).wait,'running');assert.equal(files.detail(id).artifacts.length,0);
 assert.throws(()=>processing.retry(id),{statusCode:409});
 await unlink(join(input.workerRoot,'hold-run'));
 await until(async()=>{await processing.tick();return received&&processing.cancellation(id).wait===null;},'late HTTP success settled');
 assert.equal(received.status,'succeeded');assert.equal(issued,1);
 assert.equal(files.detail(id).job.state,'cancelled');assert.equal(files.detail(id).artifacts.length,0);
 assert.equal(files.chunks(id).length,0);assert.equal(JSON.stringify(files.version(id)),original);
 await processing.tick();assert.equal(issued,1);assert.equal(files.detail(id).artifacts.length,0);
 }
}finally{
 await unlink(join(input.workerRoot,'hold-run')).catch(()=>{});await processing.close();store.close();await rm(directory,{recursive:true,force:true});
}
"""
        result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', script], cwd=ROOT,
            input=json.dumps({'url': 'http://127.0.0.1:'+str(f.port)+'/transcribe', 'token': TOKEN,
                              'identity': identity, 'workerRoot': str(f.root),
                              'audio': base64.b64encode(generated_audio()).decode()}),
            capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(f.runs()), 1)
        for rejection in ('busy', 'missing'):
            with self.subTest(rejection=rejection):
                rejected = self.fixture(timeout=10)
                request, audio = rejected.request()
                stream = None
                if rejection == 'busy':
                    (rejected.root/'hold-run').touch()
                    stream = rejected.raw(request, audio, str(uuid.uuid4()))
                    self.addCleanup(stream.close)
                    until(lambda: (rejected.root/'entered').exists(), 'occupied worker before Central call')
                else:
                    (rejected.models/'punctuation/model.bin').unlink()
                result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', script], cwd=ROOT,
                    input=json.dumps({'url': 'http://127.0.0.1:'+str(rejected.port)+'/transcribe', 'token': TOKEN,
                                      'identity': request['identity'], 'workerRoot': str(rejected.root),
                                      'audio': base64.b64encode(audio).decode(), 'rejection': True}),
                    capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(rejected.runs()), 1 if rejection == 'busy' else 0)
                if stream is not None:
                    stream.close()

    def test_accepted_is_observable_before_execution_and_parent_restart_preserves_unknown(self):
        f = self.fixture()
        request, audio = f.request()
        (f.root/'hold-import').touch()
        request_id = str(uuid.uuid4())
        stream = f.raw(request, audio, request_id)
        self.addCleanup(stream.close)
        until(lambda: f.fact(request_id)['state'] == 'accepted', 'accepted before child imports')
        self.assertEqual(f.runs(), [])
        self.assertNotIn('startedAt', f.fact(request_id))
        self.assertEqual(f.http('DELETE', '/executions/'+request_id, headers={'X-Mote-Request-Scope': SCOPE})[0], 409)
        f.stop()
        (f.root/'hold-import').unlink()
        f.start()
        fact = f.fact(request_id)
        self.assertEqual((fact['state'], fact['outcome']), ('unknown', 'worker_restarted'))
        self.assertNotIn('failureCode', fact)
        self.assertEqual(f.runs(), [])
        f.ready()
        self.assertEqual(f.post(request, audio, request_id)[0], 409)

    def test_request_timeout_and_independent_worker_cap_terminate_before_releasing_capacity(self):
        f = self.fixture(timeout=2, request_timeout=5)
        request, audio = f.request()
        self.assertTrue(f.health()['dependencies']['ffmpeg'])
        self.assertTrue(f.health()['diarization'])
        self.assertFalse(f.health()['wespeaker'])
        recognition = self.response(f.post(request, audio), request)
        diarize = {**request, 'operation': 'diarize', 'checkpoint': recognition['checkpoint'],
                   'speakers': {'mode': 'range', 'min': 1, 'max': 3}}
        for speakers in ({'mode': 'arbitrary-url'}, {'mode': 'range', 'min': 1},
                         {'mode': 'range', 'min': 3, 'max': 1},
                         {'mode': 'range', 'min': 1, 'max': 3, 'count': 2}):
            result = f.post({**diarize, 'speakers': speakers}, audio)
            self.assertEqual(result[0], 400)
            self.assertEqual(result[1].get('x-mote-execution-started'), 'false')
        diarize_id = str(uuid.uuid4())
        result = f.post(diarize, audio, diarize_id)
        self.assertEqual(result[1]['x-mote-receipt-id'], diarize_id)
        self.assertEqual(self.response(result, diarize)['diarization']['speakers'], diarize['speakers'])
        fact = f.fact(diarize_id)
        self.assertEqual((fact['state'], fact['stage']), ('succeeded', 'diarize'))
        self.assertGreaterEqual(fact['finishedAt'], fact['startedAt'])
        self.assertNotIn(str(f.root), json.dumps(fact))

        (f.root/'hold-run').touch()
        with ThreadPoolExecutor(1) as executor:
            held = executor.submit(f.post, request, audio, str(uuid.uuid4()), {'X-Mote-Processing-Timeout-Ms': '2000'})
            until(lambda: len(f.runs()) == 3, 'occupied shared ASR/diarization slot')
            busy = f.post(diarize, audio)
            self.response(busy, diarize, 'resource_busy')
            self.assertEqual(busy[0], 429)
            self.assertEqual(busy[1]['retry-after'], '5')
            self.assertEqual(busy[1]['x-mote-execution-started'], 'false')
            self.assertEqual(f.http('GET', '/health')[0], 200)
            (f.root/'hold-run').unlink()
            self.response(held.result(timeout=5), request)

        for timeout, cap, delay in (('1000', 1, '1.35'), ('3600000', 2, '2.2')):
            (f.root/'delay').write_text(delay)
            request_id = str(uuid.uuid4())
            result = f.post(request, audio, request_id, {'X-Mote-Processing-Timeout-Ms': timeout})
            self.response(result, request, 'inference_timeout')
            fact = f.fact(request_id)
            self.assertEqual((fact['state'], fact['failureCode']), ('failed', 'processing_timeout'))
            self.assertGreaterEqual(fact['finishedAt'], fact['startedAt'])
            self.assertFalse(pid_alive(f.runs()[-1]['pid']))
            self.assertLessEqual(f.runs()[-1]['timeout'], cap)
            self.assertEqual(list(f.scratch.iterdir()), [])
            if timeout == '1000':
                self.assertEqual(f.http('DELETE', '/executions/'+request_id, headers={'X-Mote-Request-Scope': SCOPE})[0], 200)
                self.assertEqual(f.post(request, audio, request_id)[0], 409)
                self.response(f.post(request, audio, extra={'X-Mote-Processing-Timeout-Ms': '2000'}), request)
                self.assertGreater(f.runs()[-1]['timeout'], 1)
                self.assertLessEqual(f.runs()[-1]['timeout'], 2)
        (f.root/'delay').write_text('0.01')
        self.response(f.post(request, audio), request)
        self.assertGreater(f.runs()[-1]['timeout'], 1)
        self.assertLessEqual(f.runs()[-1]['timeout'], 2)
        self.assertEqual(list(f.scratch.iterdir()), [])

    def test_complete_output_cannot_succeed_when_child_termination_exceeds_request_budget(self):
        f = self.fixture(timeout=1)
        request, audio = f.request()
        (f.root/'mode').write_text('ignore-term')
        request_id = str(uuid.uuid4())
        result = f.post(request, audio, request_id)
        self.response(result, request, 'inference_timeout')
        self.assertFalse(pid_alive(f.runs()[0]['pid']))
        self.assertEqual(f.fact(request_id)['failureCode'], 'processing_timeout')

    def test_request_and_worker_duration_limits_reject_full_recording_instead_of_truncated_success(self):
        f = self.fixture(max_audio_ms=600)
        request, audio = f.request()
        self.response(f.post(request, audio), request, 'unsupported_input')
        short = generated_audio(500)
        short_request = {**request, 'audioSha256': hashlib.sha256(short).hexdigest()}
        self.response(f.post(short_request, short), short_request)
        request['maxAudioMs'] = 200
        self.response(f.post(request, audio), request, 'unsupported_input')
        short_request['maxAudioMs'] = 14400000
        self.response(f.post(short_request, short, extra={'X-Mote-Max-Audio-Ms': '300'}), short_request, 'unsupported_input')
        self.assertEqual([row['budget'] for row in f.runs()], [600, 600, 200, 300])

    def test_invalid_uploads_and_contracts_never_start_recognition_or_publish_failed_facts(self):
        f = self.fixture()
        request, audio = f.request()
        invalid_requests = [{**request, 'audioSha256': 'a'*64}, {**request, 'protocol': 'mote.funasr/0'},
                            {**request, 'operation': 'diarize'}, {**request, 'maxAudioMs': float('nan')}]
        changed = copy.deepcopy(request)
        changed['identity']['models']['asr']['revision'] = 'a'*64
        invalid_requests.append(changed)
        for invalid in invalid_requests:
            request_id = str(uuid.uuid4())
            # Non-finite bytes exercise the real JSON parser, not its serializer.
            if not math.isfinite(invalid.get('maxAudioMs', 1)):
                body, content = multipart(request, audio)
                body = body.replace(b'"maxAudioMs":14400000', b'"maxAudioMs":NaN')
                result = f.http('POST', '/transcribe', body, {'Content-Type': content, 'X-Mote-Request-Id': request_id, 'X-Mote-Request-Scope': SCOPE})
            else:
                result = f.post(invalid, audio, request_id)
            self.assertEqual(result[1].get('x-mote-execution-started'), 'false', result)
            self.assertEqual(f.fact(request_id)['outcome'], 'receipt_unavailable')
        for extra in ({'X-Mote-Processing-Timeout-Ms': str(value)} for value in (999, 3600001, '1000.5', '100000000000', 'bad', '1.0')):
            result = f.post(request, audio, extra=extra)
            self.assertEqual(result[0], 400)
            self.assertEqual(result[1].get('x-mote-execution-started'), 'false')
        for extra in ({'X-Mote-Max-Audio-Ms': 'NaN'},
                      {'X-Mote-Max-Audio-Ms': '-1'}, {'X-Mote-Request-Id': 'not-a-uuid'}):
            result = f.post(request, audio, extra=extra)
            self.assertEqual(result[0], 400)
            self.assertEqual(result[1].get('x-mote-execution-started'), 'false')
        body, content = multipart(request, audio)
        cases = [({'Content-Type': 'application/octet-stream'}, audio),
                 ({'Content-Type': content}, body[:-5]),
                 ({'Content-Type': content}, body.replace(b'name="audio"', b'name="request"')),
                 ({'Content-Type': content}, body+b'extra'),
                 ({'Content-Type': content}, body.replace(b'application/json', b'text/plain'))]
        for headers, data in cases:
            result = f.http('POST', '/transcribe', data, headers)
            self.assertEqual(result[0], 400, result)
            self.assertEqual(result[1].get('x-mote-execution-started'), 'false')
        # Header-only oversize and missing/ambiguous lengths must fail before
        # body allocation, without creating a recognizer or a durable failure.
        for header in ('Content-Length: 9999999999\r\n', '', 'Content-Length: 1\r\nContent-Length: 2\r\n',
                       'Content-Length: 1\r\nTransfer-Encoding: chunked\r\n'):
            with socket.create_connection(('127.0.0.1', f.port), timeout=5) as stream:
                stream.sendall(('POST /transcribe HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '+TOKEN+'\r\nContent-Type: '+content+'\r\n'+header+'\r\n').encode())
                response = http.client.HTTPResponse(stream)
                response.begin()
                self.assertIn(response.status, (411, 413))
                self.assertEqual(response.getheader('X-Mote-Execution-Started'), 'false')
                response.read()
        self.assertEqual(f.runs(), [])
        for authorization in ('Bearer invalid-generated-token', 'Bearer generated-\u00e9'):
            result = f.post(request, audio, extra={'Authorization': authorization})
            self.assertEqual(result[0], 401)
            self.assertEqual(result[1].get('x-mote-execution-started'), 'false')
        self.assertEqual(list(f.scratch.iterdir()), [])

    def test_silence_is_full_success_but_partial_oversize_crash_and_cam_failure_cannot_be_success(self):
        f = self.fixture()
        request, audio = f.request()
        (f.root/'mode').write_text('silence')
        silent = self.response(f.post(request, audio), request)
        self.assertEqual(contract.read_checkpoint(silent['checkpoint'])['sentences'], [])
        empty = generated_audio(0)
        empty_request = {**request, 'audioSha256': hashlib.sha256(empty).hexdigest()}
        empty_response = self.response(f.post(empty_request, empty), empty_request)
        self.assertEqual(contract.read_checkpoint(empty_response['checkpoint'])['source']['durationMs'], 0)
        (f.root/'mode').write_text('success')
        recognition = self.response(f.post(request, audio), request)
        for mode, code in [('partial', 'inference_failed'), ('oversize', 'output_limit'), ('crash', 'inference_failed')]:
            (f.root/'mode').write_text(mode)
            self.response(f.post(request, audio), request, code)
        diarize = {**request, 'operation': 'diarize', 'checkpoint': recognition['checkpoint'], 'speakers': {'mode': 'exact', 'count': 2}}
        (f.root/'mode').write_text('error:constraint_unsatisfied')
        self.response(f.post(diarize, audio), diarize, 'constraint_unsatisfied')
        self.assertEqual(diarize['checkpoint'], recognition['checkpoint'])
        (f.root/'mode').write_text('success')
        self.response(f.post(diarize, audio), diarize)
        self.assertEqual(sum(row['operation'] == 'recognize' for row in f.runs()), 6)
        log = (f.root/'worker.log').read_text()
        self.assertNotIn('generated private diagnostic', log)
        self.assertNotIn(TEXT, log)
        self.assertNotIn(TOKEN, log)

    def test_disconnect_during_execution_terminates_owned_work_and_allows_next_request(self):
        f = self.fixture()
        request, audio = f.request()
        (f.root/'hold-run').touch()
        request_id = str(uuid.uuid4())
        stream = f.raw(request, audio, request_id)
        until(lambda: (f.root/'entered').exists(), 'inference before disconnect')
        pid = int((f.root/'entered').read_text())
        stream.close()
        until(lambda: not pid_alive(pid), 'recognizer exit after disconnect')
        until(lambda: f.fact(request_id)['state'] == 'failed', 'terminal receipt after reap')
        (f.root/'hold-run').unlink()
        self.response(f.post(request, audio), request)
        self.assertEqual(list(f.scratch.iterdir()), [])

    def test_completed_response_lost_at_transport_keeps_success_fact_and_no_replay(self):
        f = self.fixture()
        request, audio = f.request()
        request_id = str(uuid.uuid4())
        stream = f.raw(request, audio, request_id)
        until(lambda: f.fact(request_id)['state'] == 'succeeded', 'complete processing before response body is consumed')
        stream.close()
        self.assertEqual(f.fact(request_id)['state'], 'succeeded')
        f.stop()
        f.start()
        self.assertEqual(f.fact(request_id)['state'], 'succeeded')
        f.ready()
        self.assertEqual(f.post(request, audio, request_id)[0], 409)
        self.assertEqual(len(f.runs()), 1)

    def test_abandoned_or_slow_upload_does_not_create_execution_and_shutdown_does_not_hang(self):
        f = self.fixture()
        request, audio = f.request()
        request_id = str(uuid.uuid4())
        stream = f.raw(request, audio, request_id, partial=180)
        stream.close()
        until(lambda: not f.health()['busy'], 'abandoned upload capacity released')
        self.assertEqual(f.runs(), [])
        self.assertEqual(f.fact(request_id)['outcome'], 'receipt_unavailable')
        stream = f.raw(request, audio, str(uuid.uuid4()), partial=180)
        self.addCleanup(stream.close)
        until(lambda: f.health()['busy'], 'slow upload accepted at transport')
        f.stop()
        self.assertEqual(list(f.scratch.iterdir()), [])

    def test_no_configured_token_never_accepts_recordings_or_exposes_execution_facts(self):
        f = self.fixture(token='')
        request_id = str(uuid.uuid4())
        for authorization in (None, 'Bearer generated-but-not-configured'):
            headers = {'X-Mote-Request-Scope': SCOPE}
            if authorization is not None:
                headers['Authorization'] = authorization
            self.assertEqual(f.http('GET', '/health', headers=headers, auth=False)[0], 401)
            for method in ('GET', 'DELETE'):
                self.assertEqual(f.http(method, '/executions/'+request_id, headers=headers, auth=False)[0], 401)
            for operation in ('recognize', 'diarize'):
                body, content_type = multipart({'operation': operation}, generated_audio())
                result = f.http('POST', '/transcribe' if operation == 'recognize' else '/diarize', body,
                                {**headers, 'Content-Type': content_type, 'X-Mote-Request-Id': request_id}, auth=False)
                self.assertEqual(result[0], 401)
                self.assertEqual(result[1].get('x-mote-execution-started'), 'false')
                self.assertEqual(json.loads(result[2])['execution'], 'not_started')
        self.assertEqual(f.runs(), [])


if __name__ == '__main__':
    unittest.main()
