"""Generated fixtures only. Optional real-model checks live in test-file-dialogue.ts."""
import hashlib
import importlib.util
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
from mote_audio import diarization_output, exclusive_sample, normalize, sample_bytes, transcribe

class AudioPrimitives(unittest.TestCase):
    def asr_modules(self, speech, samples=64000):
        calls = []
        def model(*args, **kwargs):
            calls.append(('model', kwargs))
            return object()
        def decode(_path, sampling_rate):
            self.assertEqual(sampling_rate, 16000)
            return [0] * samples
        def recognize(audio, **kwargs):
            calls.append(('transcribe', kwargs))
            words = [SimpleNamespace(start=1.1, end=1.3, word='合成', probability=.9)]
            return iter([SimpleNamespace(start=1.1, end=1.3, text='合成', words=words)]), SimpleNamespace(duration=3)
        modules = {'faster_whisper': SimpleNamespace(WhisperModel=model, BatchedInferencePipeline=lambda _model: SimpleNamespace(transcribe=recognize)),
                   'faster_whisper.audio': SimpleNamespace(decode_audio=decode),
                   'faster_whisper.vad': SimpleNamespace(VadOptions=lambda **kwargs: SimpleNamespace(**kwargs),
                       get_speech_timestamps=lambda _audio, _options: speech)}
        return calls, modules

    def test_speech_clips_keep_original_time_and_do_not_repack_decoder_windows(self):
        calls, modules = self.asr_modules([{'start': 16000, 'end': 24000}, {'start': 48000, 'end': 64000}])
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, modules):
            result = transcribe('generated.wav', directory, 2)
        options = dict(calls)['transcribe']
        self.assertEqual(options['clip_timestamps'], [{'start': 1.0, 'end': 1.5}, {'start': 3.0, 'end': 4.0}])
        self.assertEqual(options['batch_size'], 1)
        self.assertFalse(options['vad_filter'])
        self.assertEqual(result['durationMs'], 4000)
        self.assertEqual(result['segments'][0]['words'][0]['startMs'], 1100)

    def test_no_speech_keeps_full_duration_without_inventing_text(self):
        calls, modules = self.asr_modules([])
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, modules):
            result = transcribe('generated-silence.wav', directory, 2)
        self.assertEqual(result['segments'], [])
        self.assertEqual(result['durationMs'], 4000)
        self.assertEqual(calls, [])

    def test_invalid_speech_spans_fail_instead_of_truncating_or_overlapping(self):
        for speech in [[{'start': 0, 'end': 64001}], [{'start': 0, 'end': 20000}, {'start': 19000, 'end': 24000}]]:
            calls, modules = self.asr_modules(speech)
            with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, modules):
                with self.assertRaises(ValueError):
                    transcribe('generated.wav', directory, 2)
            self.assertEqual(calls, [])

    def test_clip_over_decoder_capacity_fails_even_inside_the_original_duration(self):
        calls, modules = self.asr_modules([{'start': 0, 'end': 480001}], samples=640000)
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, modules):
            with self.assertRaises(ValueError):
                transcribe('generated-long-clip.wav', directory, 2)
        self.assertEqual(calls, [])

    def test_model_labels_do_not_share_the_preview_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'generated.wav'
            with wave.open(str(source), 'wb') as writer:
                writer.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                writer.writeframes(b'\0\0' * 16000 * 30)
            segments = [SimpleNamespace(speaker=i, start=i * 0.5, end=i * 0.5 + 0.4) for i in range(48)]
            result = diarization_output(source, segments, 30000, 0)
            self.assertEqual(result['observedSpeakers'], 48)
            self.assertEqual(len(result['segments']), 48)
            self.assertEqual(result['segments'][-1]['speaker'], 'SPEAKER_47')
            self.assertEqual(len(result['samples']), 16)
            self.assertEqual(len(result['warnings']), 2)
            self.assertIsNone(result['expectedSpeakers'])

    def test_label_output_keeps_a_hard_bound(self):
        segments = [SimpleNamespace(speaker=i, start=i, end=i + 0.5) for i in range(101)]
        with self.assertRaises(OverflowError):
            diarization_output('no-file-needed', segments, 102000, 0)

    def test_exclusive_samples_exclude_other_speakers(self):
        rows = [{'startMs': 0, 'endMs': 5000, 'speaker': 'SPEAKER_0'},
                {'startMs': 2000, 'endMs': 4000, 'speaker': 'SPEAKER_1'}]
        self.assertEqual(exclusive_sample(rows, 'SPEAKER_0'), (0, 2000))
        self.assertIsNone(exclusive_sample(rows, 'SPEAKER_1'))
        self.assertIsNone(exclusive_sample(rows, 'SPEAKER_9'))

    def test_sample_is_independently_playable_wav(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.wav'
            with wave.open(str(source), 'wb') as writer:
                writer.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                writer.writeframes(b'\0\0' * 32000)
            data = sample_bytes(source, 500, 1500)
            with wave.open(io.BytesIO(data)) as reader:
                self.assertEqual(reader.getnframes(), 16000)
                self.assertEqual(reader.getframerate(), 16000)

    def test_inference_child_denies_network(self):
        code = "from mote_audio import offline_process; import socket; offline_process(); socket.create_connection(('127.0.0.1', 9))"
        result = subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).parent, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Network is disabled', result.stderr)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg is an optional local runtime dependency')
    def test_normalization_preserves_original_and_rejects_over_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.wav'
            with wave.open(str(source), 'wb') as writer:
                writer.setparams((2, 2, 44100, 0, 'NONE', 'not compressed'))
                writer.writeframes(b'\0' * (44100 * 4 * 2))
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            self.assertEqual(normalize(source, Path(directory) / 'normalized.wav', 3000), 2000)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), digest)
            with self.assertRaises(ValueError):
                normalize(source, source, 3000)
            with self.assertRaises(OverflowError):
                normalize(source, Path(directory) / 'limited.wav', 500)

if __name__ == '__main__':
    unittest.main()
