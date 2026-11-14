"""Score generated speech against its known text/voices, without a grading LLM."""
import argparse
from collections import Counter, defaultdict
from contextlib import closing
import difflib
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import sqlite3
import unicodedata

import mote_asr_contract as contract


def characters(text):
    # This is an explicit measurement normalization, never a product intent rule.
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold()
                   if unicodedata.category(c)[0] in {'L', 'N'})


def edit_distance(left, right):
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def speaker_label(value):
    # Unknown/noise is missing attribution, never an extra person to match.
    return value if isinstance(value, str) and value and value != 'SPEAKER_UNKNOWN' else None


def optimal_mapping(weights, references, labels):
    """Maximum-weight one-to-one assignment, including unmatched people.

    Rectangular Hungarian assignment keeps the evaluation bounded by the small
    reference person count, rather than enumerating permutations of clusters.
    This is a measurement of anonymous labels, not product identity inference.
    """
    columns = list(labels) + [None] * len(references)
    u, v = [0] * (len(references) + 1), [0] * (len(columns) + 1)
    p, way = [0] * (len(columns) + 1), [0] * (len(columns) + 1)
    for i in range(1, len(references) + 1):
        p[0], column = i, 0
        minimum, used = [float('inf')] * len(p), [False] * len(p)
        while True:
            used[column] = True
            row, delta, following = p[column], float('inf'), 0
            for j in range(1, len(p)):
                if used[j]:
                    continue
                cost = -weights[references[row-1]][columns[j-1]] - u[row] - v[j]
                if cost < minimum[j]:
                    minimum[j], way[j] = cost, column
                if minimum[j] < delta:
                    delta, following = minimum[j], j
            for j in range(len(p)):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minimum[j] -= delta
            column = following
            if p[column] == 0:
                break
        while column:
            previous = way[column]
            p[column] = p[previous]
            column = previous
    mapping = {person: None for person in references}
    for j in range(1, len(p)):
        if p[j] and columns[j-1] is not None and weights[references[p[j]-1]][columns[j-1]]:
            mapping[references[p[j]-1]] = columns[j-1]
    return mapping


def score_speakers(turns, segments):
    # TTS clip boundaries include pauses: this is not standard human-annotated DER.
    weights = defaultdict(Counter)
    labeled = unlabeled = ambiguous = 0
    by_turn = []
    for turn in turns:
        counts, none, multiple = Counter(), 0, 0
        for t in range(round(turn['startMs'] + 250), round(turn['endMs'] - 250), 20):
            active = {speaker_label(s.get('speaker')) for s in segments if s['startMs'] <= t < s['endMs']}
            active.discard(None)
            if not active:
                unlabeled += 1
                none += 1
                continue
            labeled += 1
            if len(active) != 1:
                ambiguous += 1
                multiple += 1
                continue
            label = next(iter(active))
            weights[turn['speaker']][label] += 1
            counts[label] += 1
        by_turn.append({'speaker': turn['speaker'], 'singleLabelFrames': dict(counts),
                        'unlabeledFrames': none, 'overlapFrames': multiple})
    labels = sorted({label for s in segments if (label := speaker_label(s.get('speaker'))) is not None})
    references = sorted({turn['speaker'] for turn in turns})
    mapping = optimal_mapping(weights, references, labels)
    best = sum(weights[person][label] for person, label in mapping.items() if label is not None)
    return {'observedLabels': labels, 'optimalOneToOneMapping': mapping,
            'expectedLabelCount': len(references), 'observedLabelCount': len(labels),
            'labeledFrames': labeled, 'unlabeledFrames': unlabeled, 'overlapFrames': ambiguous,
            'confusionFractionOnLabeledFrames': (labeled - best) / labeled if labeled else None,
            'unlabeledFractionOfTurnInterior': unlabeled / (labeled + unlabeled) if labeled + unlabeled else None,
            'perTurn': by_turn, 'frameMs': 20, 'boundaryExclusionMs': 250,
            'definition': 'One-to-one label assignment on predicted speech in known TTS turn interiors. Unlabeled interiors include natural silence; not standard DER.'}


def read_artifacts(db, capture_id):
    """Read the saved original, even after current chunks moved to dialogue.

    file_chunks is a current evidence projection: unchanged chunks can acquire a
    new artifact_id after alignment/cleanup/correction. It is not the raw ASR.
    """
    artifacts = {}
    for key, kind, body in db.execute(
            'SELECT id,kind,json FROM file_artifacts WHERE capture_id=? AND current=1', (capture_id,)):
        if kind in ('transcript', 'diarization'):
            if kind in artifacts:
                raise ValueError('Ambiguous current '+kind)
            artifacts[kind] = (key, json.loads(body))
    raw_id, raw = artifacts['transcript']
    diarization_id, diarization = artifacts['diarization']
    transcript = raw['transcript']
    native = raw.get('output', {})
    provenance = None
    if native.get('type') == {'id': 'mote.funasr-transcript', 'version': '1'}:
        response = contract.parse_response(native['payload'])
        if response['operation'] != 'recognize' or response['status'] != 'succeeded':
            raise ValueError('A complete recognition artifact is required')
        cp = contract.read_checkpoint(response['checkpoint'])
        expected = [{key: row[key] for key in ('startMs', 'endMs', 'text')} for row in cp['sentences']]
        if transcript['segments'] != expected or transcript['durationMs'] != cp['source']['durationMs']:
            raise ValueError('Stored transcript differs from its recognition checkpoint')
        speaker_response = contract.parse_response(diarization['output']['payload'])
        if speaker_response['status'] != 'succeeded' or speaker_response['operation'] != 'diarize' or speaker_response['checkpoint'] != response['checkpoint']:
            raise ValueError('Diarization does not use the saved recognition checkpoint')
        acoustics = [{**row, 'speaker': 'SPEAKER_UNKNOWN' if row['speaker'] is None else 'SPEAKER_'+str(row['speaker'])}
                     for row in speaker_response['diarization']['segments']]
        if diarization['segments'] != acoustics:
            raise ValueError('Stored diarization differs from its native result')
        provenance = {'protocol': cp['protocol'], 'checkpointSha256': response['checkpoint']['sha256'],
                      'source': cp['source'], 'identity': cp['identity'],
                      'sentencePrecisions': sorted({row['precision'] for row in cp['sentences']}),
                      'recognitionChunks': len(cp['recognitionChunks'])}
    return raw_id, diarization_id, transcript, diarization, provenance


def score_timing(turns, segments, duration_ms):
    rows = []
    for index, turn in enumerate(turns):
        overlapping = [s for s in segments if min(s['endMs'], turn['endMs']) > max(s['startMs'], turn['startMs'])]
        rows.append({'turnIndex': index, 'speaker': turn['speaker'], 'referenceStartMs': turn['startMs'],
                     'referenceEndMs': turn['endMs'], 'missing': not overlapping,
                     'startErrorMs': min(s['startMs'] for s in overlapping)-turn['startMs'] if overlapping else None,
                     'endErrorMs': max(s['endMs'] for s in overlapping)-turn['endMs'] if overlapping else None})
    return {'missingTurnIndexes': [row['turnIndex'] for row in rows if row['missing']], 'perTurn': rows,
            'lastRecognizedEndMs': max((s['endMs'] for s in segments), default=0),
            'recordingDurationMs': duration_ms,
            'definition': 'Positive temporal intersection with generated clip bounds, including short turns; not word alignment or human speech annotations.'}


def score_attributed_text(turns, transcript, diarization, mapping):
    """Character errors after the acoustic one-to-one label assignment.

    Only native sentence assignments supply attribution. A foreign/custom
    transcript without them reports unavailable rather than guessing by overlap.
    """
    native = diarization.get('output', {}).get('payload', {})
    assignments = native.get('diarization', {}).get('assignments')
    if assignments is None:
        return None
    if len(assignments) != len(transcript['segments']):
        raise ValueError('Sentence assignments must cover the raw transcript')
    expected, actual = defaultdict(str), defaultdict(str)
    for turn in turns:
        expected[turn['speaker']] += characters(turn['text'])
    inverse = {label: person for person, label in mapping.items() if label is not None}
    unmatched = 0
    for row, cluster in zip(transcript['segments'], assignments):
        label = None if cluster is None else 'SPEAKER_'+str(cluster)
        text = characters(row['text'])
        if label not in inverse:
            unmatched += len(text)
        else:
            actual[inverse[label]] += text
    errors = unmatched + sum(edit_distance(text, actual[person]) for person, text in expected.items())
    count = sum(map(len, expected.values()))
    return {'editDistance': errors, 'referenceCharacters': count, 'unassignedOrExtraClusterCharacters': unmatched,
            'characterErrorRate': errors/count if count else None,
            'definition': 'Per-reference-speaker CER with one-to-one acoustic label mapping; unmatched text is insertion error. Not standard DER.'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reference', required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--normalize-chinese-script', action='store_true',
                        help='Also normalize both strings with pinned OpenCC t2s; raw CER remains reported')
    args = parser.parse_args()
    reference_path, run = Path(args.reference).resolve(), Path(args.run).resolve()
    reference_bytes, report_bytes = reference_path.read_bytes(), (run / 'report.json').read_bytes()
    reference, report = json.loads(reference_bytes), json.loads(report_bytes)
    assert not reference['personalDataUsed'] and not report['personalDataUsed']
    assert report['status'] == 'passed' and len(report['files']) == 1
    assert report['files'][0]['sha256'] == reference['audioSha256']
    assert hashlib.sha256(Path(reference['audioPath']).read_bytes()).hexdigest() == reference['audioSha256']
    database = run / 'vault/mote.sqlite'
    wal = database.with_name(database.name + '-wal')
    assert not wal.exists() or wal.stat().st_size == 0, 'Close the source run before reading its checkpointed database'
    database_hash = hashlib.sha256(database.read_bytes()).hexdigest()
    capture_id = report['files'][0]['captureId']
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
        raw_id, diarization_id, transcript, diarization, provenance = read_artifacts(db, capture_id)
    if provenance is not None and provenance['source']['audioSha256'] != reference['audioSha256']:
        raise ValueError('Recognition checkpoint does not belong to the reference audio')
    raw = ''.join(row['text'] for row in transcript['segments'])
    expected = characters(''.join(turn['text'] for turn in reference['turns']))
    actual = characters(raw)
    raw_character_error_rate = edit_distance(expected, actual) / len(expected) if expected else None
    normalization = 'NFKC + casefold; retain Unicode letters/numbers'
    if args.normalize_chinese_script:
        from opencc import OpenCC
        assert version('opencc-python-reimplemented') == '0.1.7', 'Use the pinned evaluation normalizer'
        convert = OpenCC('t2s').convert
        expected, actual = convert(expected), convert(actual)
        normalization += '; OpenCC t2s, opencc-python-reimplemented 0.1.7 (evaluation only; stored text unchanged)'
    errors = edit_distance(expected, actual)
    cer = errors / len(expected) if expected else None
    speakers = score_speakers(reference['turns'], diarization['segments'])
    attributed = score_attributed_text(reference['turns'], transcript, diarization, speakers['optimalOneToOneMapping'])
    timing = score_timing(reference['turns'], transcript['segments'], transcript['durationMs'])
    thresholds = {'maximumCharacterErrorRate': .10, 'maximumSpeakerConfusionOnLabeledFrames': .05,
                  'maximumUnlabeledTurnInteriorFraction': .25, 'expectedLabelCount': speakers['expectedLabelCount'],
                  'maximumSpeakerAttributedCharacterErrorRate': .10,
                  'maximumMissingTurns': 0, 'durationToleranceMs': .0625}
    passed = ((cer <= thresholds['maximumCharacterErrorRate'] if cer is not None else not transcript['segments'])
              and (not reference['turns'] or speakers['confusionFractionOnLabeledFrames'] is not None
                   and speakers['confusionFractionOnLabeledFrames'] <= thresholds['maximumSpeakerConfusionOnLabeledFrames']
                   and speakers['unlabeledFractionOfTurnInterior'] <= thresholds['maximumUnlabeledTurnInteriorFraction'])
              and len(speakers['observedLabels']) == thresholds['expectedLabelCount']
              and (attributed is None or attributed['characterErrorRate'] is None
                   or attributed['characterErrorRate'] <= thresholds['maximumSpeakerAttributedCharacterErrorRate'])
              and not timing['missingTurnIndexes']
              and abs(transcript['durationMs']-reference['durationMs']) <= thresholds['durationToleranceMs'])
    result = {'status': 'passed' if passed else 'failed', 'personalDataUsed': False, 'humanAudioAccuracyVerified': False,
              'audioSha256': reference['audioSha256'], 'referenceSha256': hashlib.sha256(reference_bytes).hexdigest(),
              'sourceReportSha256': hashlib.sha256(report_bytes).hexdigest(), 'sourceDatabaseSha256': database_hash, 'thresholds': thresholds,
              'thresholdScope': 'Generated-control regression bounds, not a user-accepted real-recording SLO',
              'transcription': {'referenceCharacters': len(expected), 'recognizedCharacters': len(actual), 'editDistance': errors,
                                'characterErrorRate': cer, 'rawCharacterErrorRate': raw_character_error_rate, 'normalization': normalization,
                                'differences': [{'reference': expected[a:b], 'recognized': actual[c:d]}
                                                for op, a, b, c, d in difflib.SequenceMatcher(None, expected, actual, autojunk=False).get_opcodes() if op != 'equal']},
              'speakerSeparation': speakers, 'speakerAttributedTranscription': attributed,
              'timing': timing, 'durationMs': reference['durationMs'],
              'artifacts': {'transcript': raw_id, 'diarization': diarization_id}, 'recognition': provenance,
              'sourceExecution': report['files'][0],
              'limitations': ['Generated clip interiors are not human speech labels or standard DER.',
                              'Sentence/VAD timing is measured as emitted; no word timings are inferred.',
                              'These controls do not establish real-recording quality or platform support.']}
    assert hashlib.sha256(database.read_bytes()).hexdigest() == database_hash, 'Source changed during evaluation'
    output = Path(args.output).resolve()
    assert not output.is_relative_to(Path(__file__).resolve().parent.parent)
    with output.open('x') as file:
        file.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'characterErrorRate': cer,
                      'labelCount': len(speakers['observedLabels']),
                      'confusionFractionOnLabeledFrames': speakers['confusionFractionOnLabeledFrames'], 'output': str(output)}))
    raise SystemExit(0 if passed else 1)


if __name__ == '__main__':
    main()
