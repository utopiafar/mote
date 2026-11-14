"""Generated model boundary for the real transcription HTTP/process worker.

--prepare writes only a new private temporary directory. No SDK, dependencies,
weights, TTS voices or personal recordings are loaded. The worker, multipart,
FFmpeg, execution facts and domain serializers are the production files.
"""
from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import shutil
import sys
import time
import wave

if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parents[4]/'scripts'))

import mote_asr_contract as contract
from mote_audio import normalize, read_pcm, speaker_previews

ROOT = Path(__file__).resolve().parent
ASSET = b'Generated ASR-07 component; never model weights.'
SETTINGS_FINGERPRINT = ((ROOT/'host-fingerprint').read_text() if (ROOT/'host-fingerprint').exists()
                        else hashlib.sha256(b'generated journey settings').hexdigest())
VERSIONS = {'funasr': contract.SDK_VERSION, 'torch': 'generated', 'numpy': 'generated'}
ROWS = [(0, 500, '不是不是不是。', 0), (0, 500, '不是不是不是。', 0),
        (500, 520, '嗯。', None), (1000, 2400, '使用扣迪士记录。', 0),
        (2000, 2600, '重叠发言。', 1), (3000, 4000, '完整尾段保留。', 1)]


class EngineError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def catalog():
    return {'version': 'generated-asr07-assets', 'models': {
        role: {'id': model, 'repository': model, 'revision': hashlib.sha256(('generated-'+role).encode()).hexdigest(),
               'license': 'generated-fixture', 'directory': role}
        for role, model in contract.MODEL_IDS.items()}, 'files': [
            {'name': role+'/model.bin', 'size': len(ASSET), 'sha256': hashlib.sha256(ASSET).hexdigest(),
             'official': 'https://example.invalid/generated/'+role} for role in contract.MODEL_IDS]}


def identities():
    # The generated asset boundary uses the real Central catalog's digest input.
    # Production catalog/engine disagreement is checked separately in the TS
    # journey; this generated identity must never be used to claim it is fixed.
    data = catalog()
    return {role: {'id': model['id'], 'revision': model['revision'], 'manifestSha256': hashlib.sha256(
        json.dumps({'model': model, 'files': [item for item in data['files'] if item['name'].startswith(role+'/')]},
                   separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()}
        for role, model in data['models'].items()}


def component_manifest(role):
    return {'files': [{'name': 'model.bin'}]}


def verify_models(root):
    if any((Path(root)/role/'model.bin').read_bytes() != ASSET for role in contract.MODEL_IDS):
        raise EngineError('model_missing')
    return identities()


class SdkRuntime:
    def __init__(self, backend, threads):
        self.versions = VERSIONS

    @contextmanager
    def component(self, role, directory):
        yield object()

    def close(self):
        pass


def run_audio(request, original, dialogue_directory, *, backend, threads, timeout, started_at):
    request = contract.parse_request(request)
    with (ROOT/'calls.jsonl').open('a') as file:
        file.write(contract.serialize(request)+'\n')
    operation = request['operation']
    (ROOT/('entered-'+operation)).touch()
    while (ROOT/('hold-'+operation)).exists():
        time.sleep(.01)
    if (ROOT/('fail-'+operation)).exists():
        raise EngineError('inference_failed')
    normalized = Path(original).with_name('normalized.wav')
    normalize(original, normalized, request['maxAudioMs'], timeout)
    pcm = read_pcm(normalized)
    source = {'audioSha256': hashlib.sha256(Path(original).read_bytes()).hexdigest(),
              'pcmSha256': hashlib.sha256(pcm).hexdigest(), 'sampleRate': 16000,
              'sampleCount': len(pcm)//2, 'durationMs': len(pcm)/32, 'timeline': 'original'}
    # Only the unavailable recognizer is scripted. Host settings are a fixture
    # parameter; the production engine's independent fingerprint is audited too.
    actual = {'sdkVersion': contract.SDK_VERSION, 'sdkWheelSha256': contract.SDK_WHEEL_SHA256,
              **contract.PINS, 'models': verify_models(dialogue_directory), 'dependencies': VERSIONS,
              'backend': backend, 'threads': threads, 'settingsFingerprint': request['identity']['settingsFingerprint']}
    rows = [] if (ROOT/'silence').exists() else ROWS
    if operation == 'recognize':
        native = {'text': '  '+''.join(row[2] for row in rows)+'\n  ' if rows else '',
                  'sentence_info': [{'start': start, 'end': end, 'text': text} for start, end, text, _ in rows]}
        return contract.recognize_to_checkpoint(request, source, actual,
            {'value': [[0, source['durationMs']]] if rows else []}, native,
            [{'text': native['text']}] if rows else [])

    def cam(cp, options):
        flip = (ROOT/'flip').exists()
        labels = [None if label is None else 1-label if flip else label for *_, label in rows]
        acoustics = [{'startMs': start, 'endMs': end, 'speaker': 1-label if flip else label}
                     for start, end, label in [(0, 520, 0), (1000, 2400, 0), (2000, 4000, 1)]] if rows else []
        count = len({row['speaker'] for row in acoustics})
        if options['mode'] == 'exact' and count != options['count'] or options['mode'] == 'range' and not options['min'] <= count <= options['max']:
            raise EngineError('constraint_unsatisfied')
        return {'timeUnit': 'ms', 'speakers': options, 'assignments': labels, 'segments': acoustics,
                'samples': speaker_previews(normalized, acoustics)}
    return contract.diarize_from_checkpoint(request, source, actual, cam)


def prepare(directory):
    root = Path(__file__).resolve().parents[4]
    directory.mkdir(mode=0o700)
    for name in ('transcription-server.py', 'mote_execution_facts.py', 'mote_asr_contract.py', 'mote_audio.py'):
        shutil.copyfile(root/'scripts'/name, directory/name)
    shutil.copyfile(__file__, directory/'mote_funasr.py')
    bundle = directory/'bundle'
    for role in contract.MODEL_IDS:
        (bundle/role).mkdir(parents=True)
        (bundle/role/'model.bin').write_bytes(ASSET)
    with wave.open(str(directory/'generated.wav'), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b''.join(int(3000*math.sin(2*math.pi*220*i/16000)).to_bytes(2, 'little', signed=True)
                                  for i in range(64000)))
    print(json.dumps({'catalog': catalog(), 'models': identities(), 'rows': ROWS}, ensure_ascii=False))


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--prepare':
        raise SystemExit('Use --prepare with a new private temporary directory')
    prepare(Path(sys.argv[2]))
