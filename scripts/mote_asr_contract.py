"""Current, restart-safe FunASR domain messages; stdlib only, no model loading.

Pinned source: funasr==1.4.25, PyPI wheel SHA256 below. Checked entrypoints:
auto/auto_model.py (6e3aadc33b014452ca31c06e8261054fd94a26038caa60e669a6bfb70aa9abe1),
models/campplus/cluster_backend.py and utils.py, models/fun_asr_nano/model.py.
SDK sentence_info requires `text`, `start`/`end` in ms. `sentence` is only a
redundant alias on some SDK branches. Nano token start_time/end_time are seconds;
an engine must convert at that explicit boundary, never infer units from values.

Recognition owner: run FSMN once, restore ASR chunk order/offsets, apply CT-Punc,
then call recognize_to_checkpoint, WITHOUT constructing/running CAM++. Central
commits this response via FileOutputRegistry before issuing a diarize request.
After restart re-normalize the same original (full PCM16 mono 16k, no trimming),
verify both hashes and frame count, and call diarize_from_checkpoint. Its only
model callback is CAM++; it receives the saved VAD/sentences, never reruns ASR.
Rebuild official sv_chunk windows (1.5s / .75s, including padded tail) from that
VAD and PCM. Run postprocess/distribute_spk on the SAME time basis. Convert the
speaker helpers' seconds to ms explicitly; unassigned/noise speakers stay None.
Do not use distribute_spk's no-overlap default 0 as evidence of a speaker.
Comparison with one-shot generate is a later real-model acceptance, not proved
by this serializer or by return_spk_res=False (which still computes embeddings).

Worker transport: POST /transcribe (recognize) or /diarize (diarize), multipart
with exactly `request` (UTF-8 application/json, <=32 MiB) and `audio` (original
application/octet-stream, <=512 MiB). Response is this UTF-8 JSON, <=32 MiB.
Reuse existing X-Mote-Request-Id/Scope, offline/auth/deadline headers and facts.
Worker owner bounds both parts before decoding and proves child exit
before reporting terminated/cancelled. Disconnect/restart alone means unknown.
No paths, waveforms, tensors, embedding objects or worker caches are archived.
"""
import base64
import bisect
import hashlib
import json
import math
import re

PROTOCOL = 'mote.funasr/1'
SDK_VERSION = '1.4.25'
SDK_WHEEL_SHA256 = '11ab7bd8c7574a94579b83a9f8fe837af46be6229462da5f3004a04a017cee75'
PINS = {'recipe': {'id': 'mote.audio-dialogue', 'version': '3'},
        'extract': {'id': 'audio.local-dialogue', 'version': '5'},
        'diarize': {'id': 'audio.diarize', 'version': '4'},
        'align': {'id': 'mote.funasr-align', 'version': '1'}}
MODEL_IDS = {'asr': 'FunAudioLLM/Fun-ASR-Nano-2512',
             'vad': 'iic/speech_fsmn_vad_zh-cn-16k-common-pytorch',
             'speaker': 'iic/speech_campplus_sv_zh-cn_16k-common',
             'punctuation': 'iic/punc_ct-transformer_cn-en-common-vocab471067-large'}
LIMITS = {'wireBytes': 32*1024*1024, 'checkpointBytes': 16*1024*1024,
          'textBytes': 4*1024*1024, 'durationMs': 86_400_000,
          'vad': 50_000, 'sentences': 50_000, 'acousticSegments': 100_000,
          'samples': 16, 'sampleBytes': 768*1024}
FAILURES = {'model_missing': ('blocked', 'not_started'),
            'component_missing': ('blocked', 'not_started'),
            'worker_not_ready': ('blocked', 'not_started'),
            'resource_busy': ('waiting', 'not_started'),
            'invalid_input': ('failed', 'not_started'),
            'contract_mismatch': ('failed', 'not_started'),
            'unsupported_input': ('failed', 'terminated'),
            'inference_failed': ('failed', 'terminated'),
            'inference_timeout': ('failed', 'terminated'),
            'output_limit': ('failed', 'terminated'),
            'constraint_unsatisfied': ('failed', 'terminated'),
            'cancelled': ('cancelled', 'terminated'),
            'response_unknown': ('unknown', 'unknown')}


class ContractError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ContractError(message)


def obj(value, keys):
    require(type(value) is dict and set(value) == set(keys), 'Unexpected or missing fields')


def number(value, lower=0, upper=LIMITS['durationMs'], integer=False):
    require(type(value) in (int, float) and math.isfinite(value) and lower <= value <= upper
            and (not integer or value == int(value)), 'Invalid finite number')


def digest(value):
    require(type(value) is str and re.fullmatch('[a-f0-9]{64}', value), 'Invalid SHA-256')


def array(value, limit):
    require(type(value) is list and len(value) <= limit, 'Array exceeds limit')


def text(value, byte_limit, nonempty=False, units=None):
    require(type(value) is str, 'Expected text field')
    require(len(value.encode('utf-8')) <= byte_limit and (not nonempty or len(value) > 0)
            and (units is None or len(value.encode('utf-16-le'))//2 <= units), 'Text exceeds limit')


def serialize(value, limit=LIMITS['wireBytes']):
    data = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'), sort_keys=True)
    require(len(data.encode('utf-8')) <= limit, 'Serialized output exceeds limit')
    return data


def loads(value, limit=LIMITS['wireBytes']):
    if isinstance(value, (str, bytes)):
        require(len(value.encode('utf-8') if isinstance(value, str) else value) <= limit, 'Input exceeds limit')
        if isinstance(value, bytes):
            value = value.decode('utf-8', errors='strict')
        return json.loads(value, parse_constant=lambda _: (_ for _ in ()).throw(ContractError('Non-finite JSON')))
    serialize(value, limit)
    return value


def validate_identity(identity):
    obj(identity, ['sdkVersion', 'sdkWheelSha256', *PINS, 'settingsFingerprint', 'models', 'dependencies', 'backend', 'threads'])
    require(identity['sdkVersion'] == SDK_VERSION and identity['sdkWheelSha256'] == SDK_WHEEL_SHA256, 'SDK identity mismatch')
    for key, pin in PINS.items():
        require(identity[key] == pin, 'Pinned implementation mismatch')
    digest(identity['settingsFingerprint'])
    obj(identity['models'], MODEL_IDS)
    for role, model_id in MODEL_IDS.items():
        model = identity['models'][role]
        obj(model, ['id', 'revision', 'manifestSha256'])
        require(model['id'] == model_id and type(model['revision']) is str
                and re.fullmatch('[a-f0-9]{40,64}', model['revision']), 'Model identity must be immutable')
        digest(model['manifestSha256'])
    deps = identity['dependencies']
    require(type(deps) is dict and 0 < len(deps) <= 32, 'Dependency versions required')
    for key, value in deps.items():
        require(type(key) is str and re.fullmatch('[a-z][a-z0-9_-]{0,63}', key)
                and type(value) is str and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,99}', value), 'Invalid dependency version')
    require(identity['backend'] in ('cpu', 'mps', 'cuda'), 'Unknown backend')
    number(identity['threads'], 1, 32, True)


def validate_source(source):
    obj(source, ['audioSha256', 'pcmSha256', 'sampleRate', 'sampleCount', 'durationMs', 'timeline'])
    digest(source['audioSha256'])
    digest(source['pcmSha256'])
    number(source['sampleCount'], 0, 1_382_400_000, True)
    number(source['durationMs'])
    require(source['sampleRate'] == 16000 and source['timeline'] == 'original'
            and source['durationMs'] == source['sampleCount']/16, 'PCM timeline mismatch')


def validate_speakers(options):
    require(type(options) is dict and 'mode' in options, 'Speaker mode required')
    mode = options['mode']
    require(mode in ('unknown', 'exact', 'range'), 'Unknown speaker mode')
    obj(options, {'unknown': ['mode'], 'exact': ['mode', 'count'], 'range': ['mode', 'min', 'max']}[mode])
    for key in ('count', 'min', 'max'):
        if key in options:
            number(options[key], 1, 16, True)
    require(mode != 'range' or options['min'] <= options['max'], 'Reversed speaker range')


def timeline(segments, duration, positive=False, disjoint=False):
    last_start = last_end = 0
    for segment in segments:
        start, end = segment['startMs'], segment['endMs']
        number(start)
        number(end)
        require((end > start if positive else end >= start) and end <= duration
                and start >= last_start and (not disjoint or start >= last_end), 'Invalid or unordered timeline')
        last_start, last_end = start, end


def validate_checkpoint(cp, expected=None):
    obj(cp, ['protocol', 'kind', 'timeUnit', 'complete', 'source', 'identity', 'text', 'vad', 'sentences', 'recognitionChunks'])
    require(cp['protocol'] == PROTOCOL and cp['kind'] == 'recognition'
            and cp['timeUnit'] == 'ms' and cp['complete'] is True, 'Incomplete or unsupported checkpoint')
    validate_source(cp['source'])
    validate_identity(cp['identity'])
    text(cp['text'], LIMITS['textBytes'])
    array(cp['vad'], LIMITS['vad'])
    array(cp['sentences'], LIMITS['sentences'])
    array(cp['recognitionChunks'], LIMITS['vad'])
    require(len(cp['recognitionChunks']) == len(cp['vad']), 'Incomplete VAD recognition coverage')
    for index, chunk in enumerate(cp['recognitionChunks']):
        obj(chunk, ['vadIndex', 'text'])
        number(chunk['vadIndex'], 0, LIMITS['vad']-1, True)
        require(chunk['vadIndex'] == index, 'Incomplete VAD recognition coverage')
        text(chunk['text'], LIMITS['textBytes'])
    for region in cp['vad']:
        obj(region, ['startMs', 'endMs'])
    for sentence in cp['sentences']:
        obj(sentence, ['startMs', 'endMs', 'text', 'precision'])
        text(sentence['text'], 32000, True, 8000)
        require(sentence['precision'] in ('sentence', 'vad'), 'Unknown timing precision')
    timeline(cp['vad'], cp['source']['durationMs'], True, True)
    timeline(cp['sentences'], cp['source']['durationMs'])
    require(bool(cp['text'].strip()) == bool(cp['sentences']), 'Text and sentence coverage disagree')
    def covered(time):
        lo, hi = 0, len(cp['vad'])
        while lo < hi:
            mid = (lo+hi)//2
            if cp['vad'][mid]['startMs'] <= time:
                lo = mid+1
            else:
                hi = mid
        return lo > 0 and cp['vad'][lo-1]['endMs'] >= time
    for sentence in cp['sentences']:
        require(covered(sentence['startMs']) and covered(sentence['endMs']), 'Sentence outside shared VAD basis')
    if expected is not None:
        require(cp['source']['audioSha256'] == expected['audioSha256'], 'Archived audio digest mismatch')
        require(cp['identity'] == expected['identity'], 'Pinned model/settings identity mismatch')
        require(cp['source']['durationMs'] <= expected['maxAudioMs'], 'Audio duration exceeds request budget')
    return cp


def archive_checkpoint(cp):
    validate_checkpoint(cp)
    data = serialize(cp, LIMITS['checkpointBytes'])
    return {'sha256': hashlib.sha256(data.encode('utf-8')).hexdigest(), 'json': data}


def read_checkpoint(archive, expected=None):
    obj(archive, ['sha256', 'json'])
    digest(archive['sha256'])
    text(archive['json'], LIMITS['checkpointBytes'])
    require(hashlib.sha256(archive['json'].encode('utf-8')).hexdigest() == archive['sha256'], 'Checkpoint digest mismatch')
    return validate_checkpoint(loads(archive['json'], LIMITS['checkpointBytes']), expected)


def parse_request(value):
    request = loads(value)
    require(type(request) is dict and request.get('operation') in ('recognize', 'diarize'), 'Unknown operation')
    obj(request, ['protocol', 'operation', 'audioSha256', 'maxAudioMs', 'identity']
        + (['checkpoint', 'speakers'] if request['operation'] == 'diarize' else []))
    require(request['protocol'] == PROTOCOL, 'Unsupported protocol')
    digest(request['audioSha256'])
    number(request['maxAudioMs'], 1)
    validate_identity(request['identity'])
    if request['operation'] == 'diarize':
        validate_speakers(request['speakers'])
        read_checkpoint(request['checkpoint'], request)
    return request


def checkpoint_from_sdk(source, identity, vad_result, sdk_result, recognized_chunks, precision):
    """Adapter for the restored AutoModel sentence boundary, not Nano token dicts.

    The engine supplies its captured FSMN `value` from the SAME recognition run.
    Empty VAD's documented result can omit sentence_info; nonempty text cannot.
    Unexpected missing `text` is always an error, even if `sentence` exists.
    """
    require(type(vad_result) is dict and 'value' in vad_result, 'SDK VAD value required')
    array(vad_result['value'], LIMITS['vad'])
    require(type(sdk_result) is dict and 'text' in sdk_result, 'SDK text field required')
    # Capture AutoModel's restored_data before merging/punctuation. Exactly one
    # completed ASR result (possibly empty text) per original VAD region. Missing
    # batch results cannot silently become a complete transcript.
    array(recognized_chunks, LIMITS['vad'])
    require(len(recognized_chunks) == len(vad_result['value']), 'Incomplete VAD recognition coverage')
    chunks = []
    for index, chunk in enumerate(recognized_chunks):
        require(type(chunk) is dict and 'text' in chunk, 'SDK chunk text field required')
        chunks.append({'vadIndex': index, 'text': chunk['text']})
    text(sdk_result['text'], LIMITS['textBytes'])
    if 'sentence_info' not in sdk_result:
        require(sdk_result['text'] == '' and not vad_result['value'], 'SDK sentence_info required')
    native = sdk_result.get('sentence_info', [])
    array(native, LIMITS['sentences'])
    sentences = []
    for item in native:
        require(type(item) is dict and all(k in item for k in ('text', 'start', 'end')), 'SDK sentence text/start/end required')
        if 'sentence' in item:
            require(item['sentence'] == item['text'], 'Conflicting SDK sentence alias')
        sentences.append({'startMs': item['start'], 'endMs': item['end'], 'text': item['text'], 'precision': precision})
    vad = []
    for item in vad_result['value']:
        require(type(item) in (list, tuple) and len(item) == 2, 'Invalid SDK VAD interval')
        vad.append({'startMs': item[0], 'endMs': item[1]})
    cp = {'protocol': PROTOCOL, 'kind': 'recognition', 'timeUnit': 'ms', 'complete': True,
          'source': source, 'identity': identity, 'text': sdk_result['text'], 'vad': vad, 'sentences': sentences, 'recognitionChunks': chunks}
    return validate_checkpoint(cp)


def validate_diarization(result, cp):
    obj(result, ['timeUnit', 'speakers', 'assignments', 'segments', 'samples'])
    require(result['timeUnit'] == 'ms', 'Explicit milliseconds required')
    validate_speakers(result['speakers'])
    array(result['assignments'], LIMITS['sentences'])
    array(result['segments'], LIMITS['acousticSegments'])
    array(result['samples'], LIMITS['samples'])
    require(len(result['assignments']) == len(cp['sentences']), 'Every sentence needs an assignment')
    for segment in result['segments']:
        obj(segment, ['startMs', 'endMs', 'speaker'])
        if segment['speaker'] is not None:
            number(segment['speaker'], 0, 99999, True)
    timeline(result['segments'], cp['source']['durationMs'], True)
    labels = {s['speaker'] for s in result['segments'] if s['speaker'] is not None}
    evidence = acoustic_evidence(result['segments'])
    for label, sentence in zip(result['assignments'], cp['sentences']):
        if label is not None:
            number(label, 0, 99999, True)
            require(label in labels and evidence(label, sentence), 'Sentence speaker has no overlapping acoustic evidence')
    previews = set()
    for sample in result['samples']:
        obj(sample, ['startMs', 'endMs', 'speaker', 'wavBase64'])
        number(sample['speaker'], 0, 99999, True)
        require(sample['speaker'] in labels and sample['speaker'] not in previews, 'Invalid speaker preview')
        previews.add(sample['speaker'])
        timeline([sample], cp['source']['durationMs'], True)
        text(sample['wavBase64'], 1024*1024)
        raw = base64.b64decode(sample['wavBase64'], validate=True)
        require(len(raw) <= LIMITS['sampleBytes'] and base64.b64encode(raw).decode() == sample['wavBase64']
                and raw[:4] == b'RIFF' and raw[8:12] == b'WAVE', 'Invalid bounded WAV preview')


def acoustic_evidence(segments):
    # Starts are ordered; prefix maximum ends also handle overlapping/nested
    # acoustics. Lookup stays bounded at the contract's full row limits.
    index = {}
    for segment in segments:
        if segment['speaker'] is None:
            continue
        starts, ends = index.setdefault(segment['speaker'], ([], []))
        starts.append(segment['startMs'])
        ends.append(max(ends[-1] if ends else 0, segment['endMs']))
    def present(label, sentence):
        if label not in index:
            return False
        starts, ends = index[label]
        search = bisect.bisect_left if sentence['endMs'] > sentence['startMs'] else bisect.bisect_right
        position = search(starts, sentence['endMs'])-1
        return position >= 0 and ends[position] > sentence['startMs']
    return present


def parse_response(value, expected=None):
    response = loads(value)
    require(type(response) is dict and response.get('operation') in ('recognize', 'diarize'), 'Unknown operation')
    require(response.get('protocol') == PROTOCOL, 'Unsupported protocol')
    if expected is not None:
        require(response['operation'] == expected['operation'], 'Worker operation mismatch')
    if response.get('status') != 'succeeded':
        obj(response, ['protocol', 'operation', 'status', 'code', 'execution', 'retryAfterMs'])
        require(response['code'] in FAILURES and (response['status'], response['execution']) == FAILURES[response['code']], 'Inconsistent worker failure')
        if response['code'] == 'resource_busy':
            number(response['retryAfterMs'], 1, 60_000, True)
        else:
            require(response['retryAfterMs'] is None, 'Unexpected retry delay')
        return response
    obj(response, ['protocol', 'operation', 'status', 'checkpoint']
        + (['diarization'] if response['operation'] == 'diarize' else []))
    cp = read_checkpoint(response['checkpoint'], expected)
    if response['operation'] == 'diarize':
        validate_diarization(response['diarization'], cp)
        if expected is not None:
            require(response['checkpoint']['sha256'] == expected['checkpoint']['sha256'], 'Diarization changed recognition checkpoint')
            require(response['diarization']['speakers'] == expected['speakers'], 'Speaker declaration mismatch')
    return response


def recognize_to_checkpoint(request, source, actual_identity, vad_result, sdk_result, recognized_chunks, precision='sentence'):
    request = parse_request(request)
    require(request['operation'] == 'recognize', 'Recognition request required')
    cp = checkpoint_from_sdk(source, actual_identity, vad_result, sdk_result, recognized_chunks, precision)
    validate_checkpoint(cp, request)
    return serialize({'protocol': PROTOCOL, 'operation': 'recognize', 'status': 'succeeded', 'checkpoint': archive_checkpoint(cp)})


def diarize_from_checkpoint(request, normalized_source, actual_identity, run_cam, cancelled=lambda: False):
    """Standalone retry boundary. run_cam(cp, options) returns ms acoustics and
    one nullable cluster per saved sentence. No ASR/VAD model callback exists.
    Cancellation raises before serialization; the HTTP owner proves termination.
    """
    request = parse_request(request)
    require(request['operation'] == 'diarize', 'Diarization request required')
    cp = read_checkpoint(request['checkpoint'], request)
    validate_source(normalized_source)
    require(normalized_source == cp['source'], 'Renormalized audio does not match checkpoint')
    validate_identity(actual_identity)
    require(actual_identity == cp['identity'], 'Worker model/settings identity does not match checkpoint')
    require(not cancelled(), 'Cancelled before CAM++')
    # Isolate model code from the archived structure, including caller mutation.
    result = run_cam(loads(serialize(cp)), dict(request['speakers']))
    require(not cancelled(), 'Cancelled during CAM++')
    response = {'protocol': PROTOCOL, 'operation': 'diarize', 'status': 'succeeded',
                'checkpoint': request['checkpoint'], 'diarization': result}
    parse_response(response, request)
    return serialize(response)


def speakers_from_sdk(cp, options, sentence_info, segments_seconds, samples):
    """Fixed CAM++ export boundary. postprocess yields [start_s,end_s,cluster].
    distribute_spk sentence dicts use ms and optional spk; missing/None/noise -1
    remain unassigned. The engine must leave no-overlap sentences unassigned
    rather than accepting the SDK's fabricated default 0. Recognition text and
    boundaries are immutable during diarization; one assignment per saved row.
    """
    validate_checkpoint(cp)
    validate_speakers(options)
    array(sentence_info, LIMITS['sentences'])
    array(segments_seconds, LIMITS['acousticSegments'])
    require(len(sentence_info) == len(cp['sentences']), 'SDK sentence coverage changed')
    def cluster(value):
        if value is None or type(value) in (int, float) and value == -1:
            return None
        number(value, 0, 99999, True)
        return int(value)
    assignments = []
    for native, saved in zip(sentence_info, cp['sentences']):
        require(type(native) is dict and all(k in native for k in ('text', 'start', 'end')), 'SDK sentence text/start/end required')
        require(native['text'] == saved['text'] and native['start'] == saved['startMs']
                and native['end'] == saved['endMs'], 'SDK changed recognition text or timeline')
        assignments.append(cluster(native.get('spk')))
    segments = []
    for item in segments_seconds:
        require(type(item) in (list, tuple) and len(item) == 3, 'Invalid CAM++ postprocess segment')
        number(item[0], 0, LIMITS['durationMs']/1000)
        number(item[1], 0, LIMITS['durationMs']/1000)
        segments.append({'startMs': item[0]*1000, 'endMs': item[1]*1000, 'speaker': cluster(item[2])})
    timeline(segments, cp['source']['durationMs'], True)
    evidence = acoustic_evidence(segments)
    assignments = [label if label is not None and evidence(label, sentence) else None
                   for label, sentence in zip(assignments, cp['sentences'])]
    result = {'timeUnit': 'ms', 'speakers': options, 'assignments': assignments, 'segments': segments, 'samples': samples}
    validate_diarization(result, cp)
    return result


def worker_failure(operation, code):
    require(operation in ('recognize', 'diarize') and code in FAILURES, 'Unknown worker failure')
    status, execution = FAILURES[code]
    return serialize({'protocol': PROTOCOL, 'operation': operation, 'status': status,
                      'code': code, 'execution': execution, 'retryAfterMs': 5000 if code == 'resource_busy' else None})


def speaker_clustering_plan(options, embedding_count):
    """Executable arguments for pinned official clustering classes (no models).

    Unknown uses ClusterBackend(max_num_spks=16). Explicit constraints bypass its
    <20 => one-speaker shortcut and its post-cluster cosine merge (which can
    violate a lower bound). Range uses official SpectralCluster min/max args;
    exact uses its oracle_num, or official KMeansCluster at >=2048 embeddings.
    Range's spectral cost and quality need later model/scale acceptance.
    Insufficient evidence is an explicit failure, never synthetic people.
    """
    validate_speakers(options)
    number(embedding_count, 0, LIMITS['acousticSegments'], True)
    if options['mode'] == 'unknown':
        if embedding_count == 0:
            return {'class': 'empty', 'init': {}, 'call': {}}
        return {'class': 'ClusterBackend', 'init': {'max_num_spks': 16}, 'call': {'oracle_num': None}}
    lower = options['count'] if options['mode'] == 'exact' else options['min']
    upper = options['count'] if options['mode'] == 'exact' else options['max']
    require(embedding_count >= lower, 'constraint_unsatisfied')
    exact = lower == upper or embedding_count == lower
    if exact:
        if embedding_count >= 2048:
            return {'class': 'KMeansCluster', 'init': {}, 'call': {'num_clusters': lower}}
        return {'class': 'SpectralCluster', 'init': {'min_num_spks': lower, 'max_num_spks': lower}, 'call': {'oracle_num': lower}}
    return {'class': 'SpectralCluster', 'init': {'min_num_spks': lower, 'max_num_spks': min(upper, embedding_count-1)}, 'call': {'oracle_num': None}}
