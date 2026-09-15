"""Generated fixtures only. Optional real-model checks live in test-file-dialogue.ts."""
import hashlib
import importlib.util
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
from mote_audio import exclusive_sample, normalize, sample_bytes

class AudioPrimitives(unittest.TestCase):
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
