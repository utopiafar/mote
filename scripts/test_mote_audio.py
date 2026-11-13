"""Generated PCM only; normalization, interval mapping and WAV export stay real."""
import base64
import hashlib
import io
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

from mote_audio import (exclusive_sample, file_sha256, frame_interval, normalize,
                        read_pcm, sample_bytes, speaker_previews)


def generated_wav(path, frames, channels=1, rate=16000):
    pcm = b''.join(struct.pack('<h', (i % 2000) - 1000) * channels for i in range(frames))
    with wave.open(str(path), 'wb') as writer:
        writer.setparams((channels, 2, rate, 0, 'NONE', 'not compressed'))
        writer.writeframes(pcm)
    return pcm


class AudioPrimitives(unittest.TestCase):
    def test_model_labels_do_not_share_the_preview_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'generated.wav'
            generated_wav(source, 16000 * 30)
            rows = [{'speaker': i, 'startMs': i*500, 'endMs': i*500+400} for i in range(48)]
            clips = speaker_previews(source, rows)
            self.assertEqual(len({r['speaker'] for r in rows}), 48)
            self.assertEqual(len(rows), 48)
            self.assertEqual(rows[-1]['speaker'], 47)
            self.assertEqual(len(clips), 16)
            self.assertEqual([clip['speaker'] for clip in clips], list(range(16)))

    def test_label_output_keeps_a_hard_bound(self):
        rows = [{'speaker': i, 'startMs': i*1000, 'endMs': i*1000+500} for i in range(100001)]
        with self.assertRaises(OverflowError):
            speaker_previews('no-file-needed', rows)

    def test_long_recording_fragmentation_retains_every_model_label(self):
        for count in (140, 189):
            with tempfile.TemporaryDirectory() as directory:
                source = Path(directory)/'generated.wav'
                generated_wav(source, count*8000)
                rows = [{'speaker': i, 'startMs': i*500, 'endMs': i*500+400} for i in range(count)]
                before = [dict(row) for row in rows]
                clips = speaker_previews(source, rows)
                self.assertEqual(rows, before)
                self.assertEqual([r['speaker'] for r in rows], list(range(count)))
                self.assertEqual(len(clips), 16)
                for clip in clips:
                    with wave.open(io.BytesIO(base64.b64decode(clip['wavBase64']))) as reader:
                        self.assertEqual(reader.getnframes(), 6400)

    def test_exclusive_samples_exclude_other_and_unknown_speakers(self):
        rows = [{'startMs': 0, 'endMs': 5000, 'speaker': 0},
                {'startMs': 2000, 'endMs': 4000, 'speaker': 1}]
        self.assertEqual(exclusive_sample(rows, 0), (0, 2000))
        self.assertIsNone(exclusive_sample(rows, 1))
        self.assertIsNone(exclusive_sample(rows, 9))
        self.assertEqual(exclusive_sample([rows[0], {**rows[1], 'speaker': None}], 0), (0, 2000))

    def test_fully_overlapped_speakers_get_no_fabricated_clean_sample(self):
        rows = [{'startMs': 0, 'endMs': 2000, 'speaker': speaker} for speaker in (0, 1)]
        self.assertEqual(speaker_previews('no-file-needed', rows), [])
        self.assertEqual(speaker_previews('no-file-needed', [{'startMs': 0, 'endMs': 200, 'speaker': 0}]), [])

    def test_preview_budget_counts_playable_clips_rather_than_hiding_later_voices(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'generated.wav'
            generated_wav(source, 40000)
            rows = [{'startMs': 0, 'endMs': 100, 'speaker': i} for i in range(16)]
            rows.append({'startMs': 1000, 'endMs': 2000, 'speaker': 189})
            self.assertEqual([c['speaker'] for c in speaker_previews(source, rows)], [189])

    def test_sample_is_independently_playable_wav_with_exact_original_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.wav'
            pcm = generated_wav(source, 32000)
            data = sample_bytes(source, 500, 1500)
            with wave.open(io.BytesIO(data)) as reader:
                self.assertEqual(reader.getnframes(), 16000)
                self.assertEqual(reader.getframerate(), 16000)
                self.assertEqual(reader.getnchannels(), 1)
                self.assertEqual(reader.getsampwidth(), 2)
                self.assertEqual(reader.readframes(16000), pcm[16000:48000])
            self.assertEqual(read_pcm(source), pcm)
            self.assertEqual(file_sha256(source), hashlib.sha256(source.read_bytes()).hexdigest())

    def test_preview_never_silently_clamps_outside_audio_or_exceeds_byte_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'source.wav'
            generated_wav(source, 16000*30)
            for start, end in [(-1, 100), (0, 30001), (100, 100), (200, 100), (0, float('inf')), (float('nan'), 100)]:
                with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                    sample_bytes(source, start, end)
            with self.assertRaises(OverflowError):
                sample_bytes(source, 0, 30000)
            self.assertEqual(frame_interval(.0625, .125, 2), (1, 2))

    def test_inference_child_denies_network(self):
        code = "from mote_audio import offline_process; import socket; offline_process(); socket.create_connection(('127.0.0.1', 9))"
        result = subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).parent, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Network is disabled', result.stderr)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg is an optional local runtime dependency')
    def test_normalization_preserves_original_and_rejects_over_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.wav'
            generated_wav(source, 44100*2, channels=2, rate=44100)
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            self.assertEqual(normalize(source, Path(directory) / 'normalized.wav', 3000), 2000)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), digest)
            with self.assertRaises(ValueError):
                normalize(source, source, 3000)
            with self.assertRaises(OverflowError):
                normalize(source, Path(directory) / 'limited.wav', 500)

    def test_decoder_keeps_protocol_duration_and_wall_clock_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory)/'input.wav', Path(directory)/'output.wav'
            generated_wav(destination, 16000)
            with patch('mote_audio.subprocess.run') as run:
                normalize(source, destination, 1000, 17)
            command = run.call_args.args[0]
            self.assertEqual(command[command.index('-protocol_whitelist')+1], 'file,pipe')
            self.assertIn('-n', command)
            self.assertEqual(run.call_args.kwargs['timeout'], 17)
            for budget in (0, -1, float('inf'), float('nan'), 86400001):
                with self.subTest(budget=budget), self.assertRaises(ValueError):
                    normalize(source, destination, budget)

    def test_pcm_reader_rejects_wrong_format_and_truncated_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'input.wav'
            generated_wav(source, 100, channels=2)
            with self.assertRaises(ValueError):
                read_pcm(source)
            generated_wav(source, 100)
            source.write_bytes(source.read_bytes()[:-2])
            with self.assertRaises(ValueError):
                read_pcm(source)


if __name__ == '__main__':
    unittest.main()
