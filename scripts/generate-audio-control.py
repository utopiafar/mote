"""Generate a local macOS TTS control with exact voice/turn provenance; no network."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import wave


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--gap-ms', type=int, default=700)
    args = parser.parse_args()
    if not 0 <= args.gap_ms <= 5000:
        raise ValueError('Gap must be between zero and five seconds')
    root = Path(__file__).resolve().parent.parent
    output = Path(args.output).resolve()
    if output.is_relative_to(root):
        raise ValueError('Keep generated audio and reports outside Git')
    output.mkdir(mode=0o700)
    fixture = root / 'scripts/fixtures/audio-two-voices.json'
    data = json.loads(fixture.read_text())
    voices = {'A': 'Tingting (中文（中国大陆）)', 'B': 'Eddy (中文（中国大陆）)'}
    rate, cursor, parts = 16000, 0, []
    for index, turn in enumerate(data['turns']):
        text_path, wave_path = output / f'turn-{index}.txt', output / f'turn-{index}.wav'
        text_path.write_text(turn['text'])
        subprocess.run(['say', '-v', voices[turn['speaker']], '-r', '175', '-f', str(text_path),
                        '--file-format=WAVE', '--data-format=LEI16@16000', '-o', str(wave_path)],
                       check=True, timeout=60, capture_output=True)
        with wave.open(str(wave_path), 'rb') as audio:
            assert audio.getframerate() == rate and audio.getnchannels() == 1 and audio.getsampwidth() == 2
            frames = audio.readframes(audio.getnframes())
        turn.update(startMs=cursor / rate * 1000, endMs=(cursor + len(frames) // 2) / rate * 1000,
                    voice=voices[turn['speaker']], audioSha256=hashlib.sha256(frames).hexdigest())
        parts.append(frames)
        cursor += len(frames) // 2
        if index + 1 < len(data['turns']):
            gap = bytes(round(rate * args.gap_ms / 1000) * 2)
            parts.append(gap)
            cursor += len(gap) // 2
    audio_path = output / 'two-voices.wav'
    with wave.open(str(audio_path), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(b''.join(parts))
    data.update(fixtureSha256=hashlib.sha256(fixture.read_bytes()).hexdigest(),
                audioPath=str(audio_path), audioSha256=hashlib.sha256(audio_path.read_bytes()).hexdigest(),
                durationMs=cursor / rate * 1000, sampleRate=rate, generator='macOS say, 175 words per minute',
                personalDataUsed=False, humanAudioTested=False, overlaps=False, insertedGapMs=args.gap_ms)
    (output / 'reference.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    manifest = {'personalDataUsed': False, 'files': [{'id': 'generated-two-voices', 'path': str(audio_path),
                'mimeType': 'audio/wav', 'observedAt': '2026-09-26T00:00:00Z'}]}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'turns': len(data['turns']), 'durationMs': data['durationMs'],
                      'voices': voices, 'sha256': data['audioSha256']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
