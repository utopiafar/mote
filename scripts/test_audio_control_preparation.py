import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

spec = importlib.util.spec_from_file_location('preparation', Path(__file__).with_name('prepare-audio-control.py'))
preparation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparation)


class AudioPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mote-audio-preparation-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.base = self.root / 'baseline'; self.base.mkdir()
        self.extra = self.root / 'extra'; self.extra.mkdir()
        fixture = Path(__file__).with_name('fixtures') / 'audio-two-voices.json'
        reference = json.loads(fixture.read_text()); self.clips = []
        for index, turn in enumerate(reference['turns']):
            # Generated non-speech PCM tests preparation, never ASR quality.
            pcm = (1000 + index).to_bytes(2, 'little', signed=True) * (16000 + index * 100)
            self.write_wave(self.base / ('turn-' + str(index) + '.wav'), pcm)
            self.clips.append({**turn, 'voice': preparation.VOICES[turn['speaker']], 'pcm': pcm})
        pcm, rows = preparation.concatenate(self.clips, 11200)
        self.write_wave(self.base / 'two-voices.wav', pcm)
        reference.update(personalDataUsed=False, humanAudioTested=False,
                         fixtureSha256=preparation.digest(fixture.read_bytes()), insertedGapMs=700,
                         durationMs=len(pcm) / 32,
                         audioSha256=preparation.digest((self.base / 'two-voices.wav').read_bytes()))
        for turn, row, clip in zip(reference['turns'], rows, self.clips):
            turn.update(startMs=row['startMs'], endMs=row['endMs'], voice=clip['voice'],
                        audioSha256=preparation.digest(clip['pcm']))
        preparation.save_json(self.base / 'reference.json', reference)
        items = []
        for name, (speaker, text) in preparation.EXTRA.items():
            target = self.extra / (name + '.wav'); pcm = b'\x40\x00' * 16000
            self.write_wave(target, pcm)
            items.append({'id': name, 'speaker': speaker, 'voice': preparation.VOICES[speaker],
                          'text': text, 'path': str(target), 'sampleFrames': 16000,
                          'audioSha256': preparation.digest(target.read_bytes()), 'pcmSha256': preparation.digest(pcm)})
        preparation.save_json(self.extra / 'reference.json', {'personalDataUsed': False, 'modelInference': False, 'items': items})

    def write_wave(self, path, pcm):
        with wave.open(str(path), 'wb') as target:
            target.setnchannels(1); target.setsampwidth(2); target.setframerate(16000); target.writeframes(pcm)

    def make_suite(self):
        output = self.root / 'suite'; output.mkdir()
        preparation.suite(self.base, self.extra, output)
        return output

    def test_suite_keeps_the_original_eight_turns_and_seven_independent_references(self):
        before = {p.name: p.read_bytes() for p in self.base.iterdir()}
        output = self.make_suite()
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.base.iterdir()})
        manifest = json.loads((output / 'manifest.json').read_text())
        references = json.loads((output / 'references.json').read_text())
        self.assertEqual(len(manifest['files']), 7)
        self.assertEqual([row['expectedSpeakerCount'] for row in references['references']], [2, 1, 1, 0, 1, 1, 2])
        self.assertEqual(references['references'][0]['turns'], 8)
        self.assertEqual(references['longRecordingStatus'], 'not_run')
        for row in references['references']:
            item = next(item for item in manifest['files'] if item['id'] == row['id'])
            pcm = preparation.read_pcm(item['path'])
            self.assertEqual(row['tailAnchor']['endFrame'], len(pcm) // 2)
            self.assertEqual(row['tailAnchor']['pcmSha256'], preparation.digest(pcm[-32000:]))

    def test_repetition_silence_and_overlap_preserve_exact_source_pcm(self):
        output = self.make_suite(); first = self.clips[0]['pcm']; second = self.clips[1]['pcm']
        self.assertEqual(preparation.read_pcm(output / 'real-repeat/real-repeat.wav'), first + bytes(22400) + first)
        self.assertEqual(preparation.read_pcm(output / 'silence/silence.wav'), bytes(160000))
        mixed = preparation.read_pcm(output / 'overlap/overlap.wav')
        self.assertEqual(int.from_bytes(mixed[:2], 'little', signed=True), 500)
        self.assertEqual(int.from_bytes(mixed[16000:16002], 'little', signed=True), 1000)
        self.assertEqual(len(mixed) // 2, max(len(first) // 2, 8000 + len(second) // 2))
        original_a = [clip for clip in self.clips if clip['speaker'] == 'A']
        self.assertEqual(preparation.read_pcm(output / 'single-voice/single-voice.wav'), bytes(22400).join(clip['pcm'] for clip in original_a))

    def test_changed_original_text_and_changed_supplement_bytes_are_rejected(self):
        reference = json.loads((self.base / 'reference.json').read_text())
        reference['turns'][0]['text'] = 'Short replacement is forbidden'
        (self.base / 'reference.json').write_text(json.dumps(reference))
        with patch.object(preparation.subprocess, 'run') as command:
            with self.assertRaisesRegex(ValueError, 'speaker order or text'):
                preparation.suite(self.base, self.extra, self.root)
            command.assert_not_called()
        self.setUp()
        self.write_wave(self.extra / 'mixed.wav', b'\x41\x00' * 16000)
        with self.assertRaisesRegex(ValueError, 'digest or length'):
            preparation.supplements(self.extra)

    def test_supplement_commands_deny_network_and_use_only_two_fixed_chinese_voices(self):
        output = self.root / 'supplements'; output.mkdir(); calls = []
        def run(args, **kwargs):
            calls.append(args)
            self.assertEqual(args[:4], ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)', '/usr/bin/say'])
            self.assertEqual(kwargs['timeout'], 60)
            self.write_wave(Path(args[args.index('-o') + 1]), b'\x01\x00' * 16000)
        with patch.object(preparation.subprocess, 'run', side_effect=run):
            preparation.prepare_supplements(output)
        self.assertEqual(len(calls), 2)
        self.assertEqual({args[args.index('-v') + 1] for args in calls}, set(preparation.VOICES.values()))
        self.assertEqual(set(preparation.supplements(output)), {'mixed', 'short-interjection'})

    def test_long_plans_keep_exact_original_default_and_maximum_durations(self):
        for minutes, frames, byte_count in [(120, 115200000, 230400000), (1440, 1382400000, 2764800000)]:
            plan = preparation.long_layout(minutes, 2065235)
            self.assertEqual(plan['sampleFrames'], frames)
            self.assertEqual(plan['normalizedPcmBytes'], byte_count)
            self.assertEqual(plan['trailingEightTurnsStartFrame'] + 2065235, frames)
            self.assertEqual(plan['archiveLimitBytes'], 64 * 1024 * 1024)
            self.assertFalse(plan['continuousSpeechResourceEvidence'])
        with self.assertRaises(ValueError):
            preparation.long_layout(1, 100)

    def test_generated_output_cannot_be_created_inside_a_git_worktree(self):
        with self.assertRaisesRegex(ValueError, 'outside Git'):
            preparation.new_output(Path(__file__).parent / 'must-not-exist-generated-control')


if __name__ == '__main__':
    unittest.main()
