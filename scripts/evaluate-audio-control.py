"""Score generated speech against its known text/voices, without a grading LLM."""
import argparse
from collections import Counter, defaultdict
import difflib
import hashlib
from importlib.metadata import version
import itertools
import json
from pathlib import Path
import sqlite3
import unicodedata


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


def score_speakers(turns, segments):
    # TTS clip boundaries include pauses: this is not standard human-annotated DER.
    weights = defaultdict(Counter)
    labeled = unlabeled = ambiguous = 0
    by_turn = []
    for turn in turns:
        counts, none, multiple = Counter(), 0, 0
        for t in range(round(turn['startMs'] + 250), round(turn['endMs'] - 250), 20):
            active = {s['speaker'] for s in segments if s['startMs'] <= t < s['endMs']}
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
    labels = sorted({s['speaker'] for s in segments})
    best, mapping = 0, {}
    # An extra cluster cannot be silently merged into the expected two speakers.
    for a, b in itertools.permutations(labels + ['UNASSIGNED_A', 'UNASSIGNED_B'], 2):
        correct = weights['A'][a] + weights['B'][b]
        if correct > best:
            best, mapping = correct, {'A': a, 'B': b}
    return {'observedLabels': labels, 'optimalOneToOneMapping': mapping,
            'labeledFrames': labeled, 'unlabeledFrames': unlabeled, 'overlapFrames': ambiguous,
            'confusionFractionOnLabeledFrames': (labeled - best) / labeled if labeled else None,
            'unlabeledFractionOfTurnInterior': unlabeled / (labeled + unlabeled) if labeled + unlabeled else None,
            'perTurn': by_turn, 'frameMs': 20, 'boundaryExclusionMs': 250,
            'definition': 'One-to-one label assignment on predicted speech in known TTS turn interiors. Unlabeled interiors include natural silence; not standard DER.'}


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
    db = sqlite3.connect('file:' + str(database) + '?mode=ro&immutable=1', uri=True)
    capture_id = report['files'][0]['captureId']
    artifacts = {kind: (key, json.loads(body)) for key, kind, body in db.execute(
        'SELECT id,kind,json FROM file_artifacts WHERE capture_id=? AND current=1', (capture_id,))}
    raw_id, _ = artifacts['transcript']
    _, diarization = artifacts['diarization']
    raw = ''.join(row[0] for row in db.execute('SELECT text FROM file_chunks WHERE artifact_id=? ORDER BY start_ms,rowid', (raw_id,)))
    expected = characters(''.join(turn['text'] for turn in reference['turns']))
    actual = characters(raw)
    raw_character_error_rate = edit_distance(expected, actual) / len(expected)
    normalization = 'NFKC + casefold; retain Unicode letters/numbers'
    if args.normalize_chinese_script:
        from opencc import OpenCC
        assert version('opencc-python-reimplemented') == '0.1.7', 'Use the pinned evaluation normalizer'
        convert = OpenCC('t2s').convert
        expected, actual = convert(expected), convert(actual)
        normalization += '; OpenCC t2s, opencc-python-reimplemented 0.1.7 (evaluation only; stored text unchanged)'
    errors = edit_distance(expected, actual)
    speakers = score_speakers(reference['turns'], diarization['segments'])
    thresholds = {'maximumCharacterErrorRate': .10, 'maximumSpeakerConfusionOnLabeledFrames': .05,
                  'maximumUnlabeledTurnInteriorFraction': .25, 'expectedLabelCount': 2}
    passed = (errors / len(expected) <= thresholds['maximumCharacterErrorRate']
              and speakers['confusionFractionOnLabeledFrames'] is not None
              and speakers['confusionFractionOnLabeledFrames'] <= thresholds['maximumSpeakerConfusionOnLabeledFrames']
              and speakers['unlabeledFractionOfTurnInterior'] <= thresholds['maximumUnlabeledTurnInteriorFraction']
              and len(speakers['observedLabels']) == thresholds['expectedLabelCount'])
    result = {'status': 'passed' if passed else 'failed', 'personalDataUsed': False, 'humanAudioAccuracyVerified': False,
              'audioSha256': reference['audioSha256'], 'referenceSha256': hashlib.sha256(reference_bytes).hexdigest(),
              'sourceReportSha256': hashlib.sha256(report_bytes).hexdigest(), 'sourceDatabaseSha256': database_hash, 'thresholds': thresholds,
              'thresholdScope': 'Generated-control regression bounds, not a user-accepted real-recording SLO',
              'transcription': {'referenceCharacters': len(expected), 'recognizedCharacters': len(actual), 'editDistance': errors,
                                'characterErrorRate': errors / len(expected), 'rawCharacterErrorRate': raw_character_error_rate, 'normalization': normalization,
                                'differences': [{'reference': expected[a:b], 'recognized': actual[c:d]}
                                                for op, a, b, c, d in difflib.SequenceMatcher(None, expected, actual, autojunk=False).get_opcodes() if op != 'equal']},
              'speakerSeparation': speakers, 'durationMs': reference['durationMs']}
    assert hashlib.sha256(database.read_bytes()).hexdigest() == database_hash, 'Source changed during evaluation'
    output = Path(args.output).resolve()
    assert not output.is_relative_to(Path(__file__).resolve().parent.parent)
    with output.open('x') as file:
        file.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'characterErrorRate': errors / len(expected),
                      'labelCount': len(speakers['observedLabels']),
                      'confusionFractionOnLabeledFrames': speakers['confusionFractionOnLabeledFrames'], 'output': str(output)}))
    raise SystemExit(0 if passed else 1)


if __name__ == '__main__':
    main()
