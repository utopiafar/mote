"""Prepare fixed generated audio controls; never install or invoke ASR models.

The original eight-turn control remains a separate, unchanged specimen. Suite
derivation needs its actual WAVs and two separately generated speech clips.
Long controls require an explicit mode and keep the full declared duration.
"""
import argparse
from array import array
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import wave

RATE = 16000
VOICES = {'A': 'Tingting (中文（中国大陆）)', 'B': 'Eddy (中文（中国大陆）)'}
EXTRA = {'mixed': ('B', '今天测试 Mote。Please keep the original audio. 最后一句结束。'),
         'short-interjection': ('A', '嗯，好。')}
ARCHIVE_BYTES = 64 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_pcm(path):
    with wave.open(str(path), 'rb') as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getcomptype()) != (RATE, 1, 2, 'NONE'):
            raise ValueError('Expected generated 16 kHz mono s16 PCM')
        return audio.readframes(audio.getnframes())


def save_json(path, value):
    with path.open('x') as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
        file.write('\n')


def new_output(path):
    path = Path(path).resolve()
    if any((parent / '.git').exists() for parent in [path, *path.parents]):
        raise ValueError('Generated controls must stay outside Git worktrees')
    path.mkdir(mode=0o700)
    return path


def baseline(directory):
    directory = Path(directory).resolve()
    reference = json.loads((directory / 'reference.json').read_text())
    fixture = Path(__file__).with_name('fixtures') / 'audio-two-voices.json'
    original = json.loads(fixture.read_text())
    if reference.get('personalDataUsed') is not False or reference.get('humanAudioTested') is not False:
        raise ValueError('Only the generated non-personal baseline is accepted')
    if reference.get('fixtureSha256') != digest(fixture.read_bytes()) or len(reference['turns']) != 8:
        raise ValueError('Keep the exact original eight-turn fixture')
    if [(row['speaker'], row['text']) for row in reference['turns']] != [(row['speaker'], row['text']) for row in original['turns']]:
        raise ValueError('Original speaker order or text changed')
    audio = directory / 'two-voices.wav'
    if digest(audio.read_bytes()) != reference['audioSha256']:
        raise ValueError('Baseline WAV digest mismatch')
    clips = []
    for index, row in enumerate(reference['turns']):
        pcm = read_pcm(directory / ('turn-' + str(index) + '.wav'))
        if digest(pcm) != row['audioSha256']:
            raise ValueError('Original turn PCM changed')
        clips.append({'speaker': row['speaker'], 'text': row['text'], 'voice': row['voice'],
                      'pcm': pcm, 'sourceTurnIndex': index})
    pcm, rows = concatenate(clips, round(reference['insertedGapMs'] * RATE / 1000))
    if read_pcm(audio) != pcm:
        raise ValueError('Baseline audio no longer contains the complete original turns')
    if abs(reference['durationMs'] - len(pcm) / 32) > 0.000001:
        raise ValueError('Baseline duration mismatch')
    return reference, pcm, clips, rows


def row_for(clip, start):
    frames = len(clip['pcm']) // 2
    return {key: clip[key] for key in ('speaker', 'text', 'voice')} | {
        'startFrame': start, 'endFrame': start + frames, 'startMs': start / 16,
        'endMs': (start + frames) / 16, 'sourcePcmSha256': digest(clip['pcm']),
        **({'sourceTurnIndex': clip['sourceTurnIndex']} if 'sourceTurnIndex' in clip else {})}


def concatenate(clips, gap):
    parts, rows, cursor = [], [], 0
    for index, clip in enumerate(clips):
        if index:
            parts.append(bytes(gap * 2)); cursor += gap
        rows.append(row_for(clip, cursor))
        parts.append(clip['pcm']); cursor += len(clip['pcm']) // 2
    return b''.join(parts), rows


def overlap(first, second):
    offset = RATE // 2
    def samples(pcm):
        value = array('h'); value.frombytes(pcm)
        if sys.byteorder != 'little':
            value.byteswap()
        return value
    a, b = samples(first['pcm']), samples(second['pcm'])
    if len(a) <= offset:
        raise ValueError('The complete first turn must extend into the overlap')
    output = array('h', [0]) * max(len(a), offset + len(b))
    for index in range(len(output)):
        output[index] = ((a[index] if index < len(a) else 0) +
                         (b[index - offset] if offset <= index < offset + len(b) else 0)) // 2
    if sys.byteorder != 'little':
        output.byteswap()
    return output.tobytes(), [row_for(first, 0), row_for(second, offset)]


def tail_anchor(pcm, rows):
    end = len(pcm) // 2; start = max(0, end - RATE)
    last = max(rows, key=lambda row: row['endFrame']) if rows else None
    return {'startFrame': start, 'endFrame': end, 'pcmSha256': digest(pcm[start * 2:]),
            'lastTurnText': last['text'] if last else None,
            'timingPrecision': 'generated-clip; no inferred word boundaries'}


def prepare_supplements(output):
    items = []
    for name, (speaker, text) in EXTRA.items():
        source = output / (name + '.txt'); source.write_text(text)
        target = output / (name + '.wav')
        subprocess.run(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)',
                        '/usr/bin/say', '-v', VOICES[speaker], '-r', '175', '-f', str(source),
                        '--file-format=WAVE', '--data-format=LEI16@16000', '-o', str(target)],
                       check=True, timeout=60, capture_output=True)
        pcm = read_pcm(target)
        items.append({'id': name, 'speaker': speaker, 'voice': VOICES[speaker], 'text': text,
                      'path': str(target), 'sampleFrames': len(pcm) // 2,
                      'audioSha256': digest(target.read_bytes()), 'pcmSha256': digest(pcm)})
    save_json(output / 'reference.json', {'personalDataUsed': False, 'humanAudioTested': False,
        'modelInference': False, 'sampleRate': RATE, 'channels': 1, 'sampleWidthBytes': 2,
        'wordsPerMinute': 175, 'items': items})


def supplements(directory):
    source = json.loads((Path(directory) / 'reference.json').read_text())
    if source.get('personalDataUsed') is not False or source.get('modelInference') is not False:
        raise ValueError('Expected generated supplemental speech')
    if {row['id'] for row in source['items']} != set(EXTRA) or len(source['items']) != 2:
        raise ValueError('Expected exactly the fixed mixed and interjection clips')
    result = {}
    for row in source['items']:
        speaker, text = EXTRA[row['id']]; path = Path(row['path']); pcm = read_pcm(path)
        if (row['speaker'], row['voice'], row['text']) != (speaker, VOICES[speaker], text):
            raise ValueError('Supplemental source parameters changed')
        if digest(path.read_bytes()) != row['audioSha256'] or digest(pcm) != row['pcmSha256'] or len(pcm) // 2 != row['sampleFrames']:
            raise ValueError('Supplemental audio digest or length mismatch')
        result[row['id']] = {'speaker': speaker, 'voice': VOICES[speaker], 'text': text, 'pcm': pcm}
    return result


def reference_for(base, audio, pcm, rows, name, overlaps=False):
    return {'description': name, 'personalDataUsed': False, 'humanAudioTested': False,
        'modelInference': False, 'audioPath': str(audio), 'audioSha256': digest(audio.read_bytes()),
        'sampleRate': RATE, 'durationMs': len(pcm) / 32, 'expectedSpeakerCount': len({row['speaker'] for row in rows}),
        'overlaps': overlaps, 'turns': rows, 'tailAnchor': tail_anchor(pcm, rows),
        'baseAudioSha256': base['audioSha256'], 'fixtureSha256': base['fixtureSha256'],
        'preparationScriptSha256': digest(Path(__file__).read_bytes()),
        'evaluationScope': 'Generated control, not human generalization or real-model acceptance; clip times are not word times.'}


def suite(base_directory, extra_directory, output):
    base, original_pcm, clips, original_rows = baseline(base_directory)
    extra = supplements(extra_directory); gap = round(base['insertedGapMs'] * 16)
    cases = [('single-voice', *concatenate([clip for clip in clips if clip['speaker'] == 'A'], gap)),
             ('mixed', *concatenate([extra['mixed']], 0)), ('silence', bytes(5 * RATE * 2), []),
             ('short-interjection', *concatenate([extra['short-interjection']], 0)),
             ('real-repeat', *concatenate([clips[0], clips[0]], gap)),
             ('overlap', *overlap(clips[0], clips[1]))]
    files = [{'id': 'generated-two-voices', 'path': str(Path(base_directory).resolve() / 'two-voices.wav'),
              'mimeType': 'audio/wav', 'observedAt': '2026-09-26T00:00:00Z'}]
    references = [{'id': 'generated-two-voices', 'reference': str(Path(base_directory).resolve() / 'reference.json'),
                   'audioSha256': base['audioSha256'], 'turns': 8, 'expectedSpeakerCount': 2,
                   'tailAnchor': tail_anchor(original_pcm, original_rows)}]
    for name, pcm, rows in cases:
        directory = output / name; directory.mkdir(mode=0o700); audio = directory / (name + '.wav')
        with wave.open(str(audio), 'wb') as target:
            target.setnchannels(1); target.setsampwidth(2); target.setframerate(RATE); target.writeframes(pcm)
        reference = reference_for(base, audio, pcm, rows, name, name == 'overlap')
        save_json(directory / 'reference.json', reference)
        files.append({'id': 'generated-' + name, 'path': str(audio), 'mimeType': 'audio/wav', 'observedAt': '2026-09-26T00:00:00Z'})
        references.append({'id': 'generated-' + name, 'reference': str(directory / 'reference.json'),
                           'audioSha256': reference['audioSha256'], 'turns': len(rows),
                           'expectedSpeakerCount': reference['expectedSpeakerCount'], 'tailAnchor': reference['tailAnchor']})
    save_json(output / 'manifest.json', {'personalDataUsed': False, 'files': files})
    save_json(output / 'references.json', {'modelInference': False, 'originalEightTurnsPreserved': True,
        'references': references, 'longRecordingStatus': 'not_run',
        'longPlans': [long_layout(minutes, len(original_pcm) // 2) for minutes in (120, 1440)]})
    return {'samples': 7, 'originalTurns': 8, 'modelInference': False, 'longRecordingStatus': 'not_run'}


def long_layout(minutes, baseline_frames):
    if minutes not in (120, 1440):
        raise ValueError('Keep the original 120/1440 minute recording boundaries')
    frames = minutes * 60 * RATE
    if baseline_frames * 2 > frames:
        raise ValueError('The complete eight-turn source does not fit both anchors')
    return {'minutes': minutes, 'sampleFrames': frames, 'normalizedPcmBytes': frames * 2,
            'durationMs': minutes * 60000, 'leadingEightTurnsStartFrame': 0,
            'trailingEightTurnsStartFrame': frames - baseline_frames,
            'archiveLimitBytes': ARCHIVE_BYTES, 'codec': 'lossless FLAC',
            'continuousSpeechResourceEvidence': False,
            'description': 'Complete original eight turns at both ends; exact-duration silence between; no cropped speech or invented word timing.'}


def long_recording(base_directory, minutes, output):
    base, pcm, _, rows = baseline(base_directory); plan = long_layout(minutes, len(pcm) // 2)
    audio = output / ('long-' + str(minutes) + '.flac'); raw_digest = hashlib.sha256()
    command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', str(RATE),
               '-ac', '1', '-i', 'pipe:0', '-c:a', 'flac', '-compression_level', '8', '-n', str(audio)]
    with (output / 'encode.log').open('w') as log:
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log)
        try:
            def write(data):
                child.stdin.write(data); raw_digest.update(data)
            write(pcm)
            remaining = plan['sampleFrames'] - 2 * (len(pcm) // 2)
            while remaining:
                count = min(RATE, remaining); write(bytes(count * 2)); remaining -= count
            write(pcm); child.stdin.close()
            if child.wait() != 0:
                raise RuntimeError('Lossless long-control encoding failed; retain encode.log')
        finally:
            if child.poll() is None:
                child.terminate(); child.wait(timeout=5)
    if audio.stat().st_size > ARCHIVE_BYTES:
        raise ValueError('Encoded original exceeds the unchanged 64 MiB product limit')
    tail_start = plan['trailingEightTurnsStartFrame']
    tail_rows = [{**row, 'startFrame': row['startFrame'] + tail_start, 'endFrame': row['endFrame'] + tail_start,
                  'startMs': (row['startFrame'] + tail_start) / 16, 'endMs': (row['endFrame'] + tail_start) / 16} for row in rows]
    reference = reference_for(base, audio, pcm, rows, 'explicit long control')
    reference.update(durationMs=plan['durationMs'], turns=rows + tail_rows, pcmSha256=raw_digest.hexdigest(),
        longPlan=plan, tailAnchor={**tail_anchor(pcm, rows), 'startFrame': plan['sampleFrames'] - RATE,
                                 'endFrame': plan['sampleFrames']}, productPipelineStatus='not_run')
    save_json(output / 'reference.json', reference)
    save_json(output / 'manifest.json', {'personalDataUsed': False, 'files': [{'id': 'generated-long-' + str(minutes),
        'path': str(audio), 'mimeType': 'audio/flac', 'observedAt': '2026-09-26T00:00:00Z'}]})
    return plan | {'generated': True, 'modelInference': False, 'productPipelineStatus': 'not_run'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--baseline')
    parser.add_argument('--supplements')
    parser.add_argument('--prepare-supplements', action='store_true', help='Two existing offline voices only; no automatic voice installation')
    parser.add_argument('--long-minutes', type=int, choices=(120, 1440), help='Explicit heavy-input generation; never part of the short suite')
    args = parser.parse_args()
    if args.prepare_supplements:
        if args.baseline or args.supplements or args.long_minutes:
            parser.error('Supplement preparation is a separate explicit operation')
    elif not args.baseline or (not args.long_minutes and not args.supplements) or (args.long_minutes and args.supplements):
        parser.error('Choose baseline + supplements, or baseline + explicit long duration')
    output = new_output(args.output)
    if args.prepare_supplements:
        prepare_supplements(output); result = {'samples': 2, 'modelInference': False}
    elif args.long_minutes:
        result = long_recording(args.baseline, args.long_minutes, output)
    else:
        result = suite(args.baseline, args.supplements, output)
    print(json.dumps(result | {'output': str(output)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
