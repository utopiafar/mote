import importlib.util
import copy
import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import mote_asr_contract as contract
from test_mote_asr_contract import generated_identity, generated_source

spec = importlib.util.spec_from_file_location('audio_control', Path(__file__).with_name('evaluate-audio-control.py'))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class AudioControlTests(unittest.TestCase):
    turns = [{'speaker': 'A', 'startMs': 0, 'endMs': 2000},
             {'speaker': 'B', 'startMs': 2500, 'endMs': 4500},
             {'speaker': 'A', 'startMs': 5000, 'endMs': 7000}]

    def test_character_measurement_preserves_omissions_and_normalizes_punctuation(self):
        self.assertEqual(control.characters('Ａ说：去散步。'), 'a说去散步')
        self.assertEqual(control.edit_distance('今天去散步', '今天散步'), 1)
        self.assertEqual(control.edit_distance('周三', '周六'), 1)

    def test_identity_permutation_is_not_an_error(self):
        segments = [{**turn, 'speaker': 'SPEAKER_9' if turn['speaker'] == 'A' else 'SPEAKER_2'} for turn in self.turns]
        result = control.score_speakers(self.turns, segments)
        self.assertEqual(result['confusionFractionOnLabeledFrames'], 0)
        self.assertEqual(result['unlabeledFractionOfTurnInterior'], 0)
        self.assertEqual(result['optimalOneToOneMapping'], {'A': 'SPEAKER_9', 'B': 'SPEAKER_2'})

    def test_extra_clusters_are_not_silently_merged(self):
        result = control.score_speakers(self.turns, [{**turn, 'speaker': f'SPEAKER_{i}'} for i, turn in enumerate(self.turns)])
        self.assertAlmostEqual(result['confusionFractionOnLabeledFrames'], 1 / 3)
        self.assertEqual(len(result['observedLabels']), 3)

    def test_missing_and_overlapping_output_remain_visible(self):
        result = control.score_speakers(self.turns, [{'startMs': 0, 'endMs': 2000, 'speaker': 'one'},
                                                    {'startMs': 0, 'endMs': 2000, 'speaker': 'two'}])
        self.assertAlmostEqual(result['unlabeledFractionOfTurnInterior'], 2 / 3)
        self.assertEqual(result['confusionFractionOnLabeledFrames'], 1)
        self.assertGreater(result['overlapFrames'], 0)

    def test_unknown_speaker_is_missing_attribution_not_a_third_person(self):
        result = control.score_speakers(self.turns, [{**turn, 'speaker': 'SPEAKER_UNKNOWN'} for turn in self.turns])
        self.assertEqual(result['observedLabels'], [])
        self.assertEqual(result['optimalOneToOneMapping'], {'A': None, 'B': None})
        self.assertEqual(result['unlabeledFractionOfTurnInterior'], 1)
        self.assertIsNone(result['confusionFractionOnLabeledFrames'])

    def test_three_reference_people_require_a_one_to_one_match(self):
        turns = [{**turn, 'speaker': str(index)} for index, turn in enumerate(self.turns)]
        perfect = [{**turn, 'speaker': 'cluster-'+turn['speaker']} for turn in turns]
        result = control.score_speakers(turns, perfect)
        self.assertEqual(result['expectedLabelCount'], 3)
        self.assertEqual(result['confusionFractionOnLabeledFrames'], 0)
        merged = control.score_speakers(turns, [{**turn, 'speaker': 'one'} for turn in turns])
        self.assertAlmostEqual(merged['confusionFractionOnLabeledFrames'], 2/3)

    def test_short_interjection_and_missing_final_turn_cannot_disappear_inside_the_collar(self):
        turns = [{'speaker': 'A', 'startMs': 0, 'endMs': 20}, {'speaker': 'B', 'startMs': 3000, 'endMs': 4000}]
        result = control.score_timing(turns, [{'startMs': 0, 'endMs': 20}], 4000)
        self.assertEqual(result['missingTurnIndexes'], [1])
        self.assertFalse(result['perTurn'][0]['missing'])
        self.assertEqual(result['lastRecognizedEndMs'], 20)

    def test_empty_speech_reports_no_invented_people_or_timing(self):
        self.assertEqual(control.score_speakers([], [])['optimalOneToOneMapping'], {})
        self.assertEqual(control.score_timing([], [], 4000)['missingTurnIndexes'], [])
        self.assertEqual(control.score_timing([], [], 4000)['recordingDurationMs'], 4000)


class SavedArtifactEvaluation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mote-audio-control-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.audio = self.root/'generated.wav'
        # Match the production generated-source helper's exact PCM/WAV bytes.
        import wave
        with wave.open(str(self.audio), 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(bytes(2400*32))
        source = generated_source(2400)
        self.assertEqual(hashlib.sha256(self.audio.read_bytes()).hexdigest(), source['audioSha256'])
        self.turns = [{'speaker': person, 'startMs': start, 'endMs': end, 'text': text}
                      for person, start, end, text in [('A', 0, 800, '真实重复重复。'), ('B', 800, 1600, '中英 Test。'), ('A', 1600, 2400, '保留尾段。')]]
        request = {'protocol': contract.PROTOCOL, 'operation': 'recognize', 'audioSha256': source['audioSha256'],
                   'maxAudioMs': 2400, 'identity': generated_identity()}
        native = {'text': ''.join(row['text'] for row in self.turns), 'sentence_info': [
            {'start': row['startMs'], 'end': row['endMs'], 'text': row['text']} for row in self.turns]}
        recognized = contract.parse_response(contract.recognize_to_checkpoint(request, source, request['identity'],
            {'value': [[0, 2400]]}, native, [{'text': native['text']}]))
        diarize = {**request, 'operation': 'diarize', 'checkpoint': recognized['checkpoint'], 'speakers': {'mode': 'unknown'}}
        response = contract.parse_response(contract.diarize_from_checkpoint(diarize, source, request['identity'], lambda cp, options: {
            'timeUnit': 'ms', 'speakers': options, 'assignments': [9, 2, 9], 'samples': [], 'segments': [
                {'startMs': row['startMs'], 'endMs': row['endMs'], 'speaker': label} for row, label in zip(self.turns, [9, 2, 9])]}))
        self.transcript = {'durationMs': 2400, 'uncorrected': True, 'segments': [
            {key: row[key] for key in ('startMs', 'endMs', 'text')} for row in self.turns]}
        self.raw = {'transcript': self.transcript, 'output': {'type': {'id': 'mote.funasr-transcript', 'version': '1'}, 'payload': recognized}}
        self.diarization = {'durationMs': 2400, 'segments': [
            {'startMs': row['startMs'], 'endMs': row['endMs'], 'speaker': label} for row, label in zip(self.turns, ['SPEAKER_9', 'SPEAKER_2', 'SPEAKER_9'])],
            'output': {'payload': response}}
        (self.root/'vault').mkdir()
        self.database = self.root/'vault/mote.sqlite'
        with sqlite3.connect(self.database) as db:
            db.execute('CREATE TABLE file_artifacts(id TEXT, capture_id TEXT, kind TEXT, json TEXT, current INTEGER)')
            db.executemany('INSERT INTO file_artifacts VALUES(?,?,?,?,1)', [
                ('raw', 'generated', 'transcript', json.dumps(self.raw)),
                ('cam', 'generated', 'diarization', json.dumps(self.diarization)),
                ('corrected', 'generated', 'corrected-dialogue', json.dumps({'transcript': {'segments': [{'text': 'Changed by the owner'}]}}))])
            # After publication all chunks belong to dialogue/correction; the
            # original artifact remains complete and must still score as such.
            db.execute('CREATE TABLE file_chunks(artifact_id TEXT, text TEXT, start_ms INTEGER)')
            db.execute("INSERT INTO file_chunks VALUES('corrected','Changed by the owner',0)")
        (self.root/'report.json').write_text(json.dumps({'status': 'passed', 'personalDataUsed': False,
            'files': [{'sha256': source['audioSha256'], 'captureId': 'generated'}]}))
        self.reference = {'personalDataUsed': False, 'audioPath': str(self.audio), 'audioSha256': source['audioSha256'],
                          'durationMs': 2400, 'turns': self.turns}
        (self.root/'reference.json').write_text(json.dumps(self.reference))

    def run_evaluation(self, reference=None):
        if reference is not None:
            (self.root/'reference.json').write_text(json.dumps(reference))
        output = self.root/'quality.json'
        before = hashlib.sha256(self.database.read_bytes()).hexdigest()
        run = subprocess.run([sys.executable, str(Path(control.__file__)), '--reference', str(self.root/'reference.json'),
                              '--run', str(self.root), '--output', str(output)], capture_output=True, text=True, timeout=10)
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), before)
        return run, json.loads(output.read_text()) if output.exists() else None

    def test_cli_scores_saved_native_original_after_chunks_moved_and_records_exact_lineage(self):
        run, result = self.run_evaluation()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(result['transcription']['characterErrorRate'], 0)
        self.assertEqual(result['speakerAttributedTranscription']['characterErrorRate'], 0)
        self.assertEqual(result['timing']['lastRecognizedEndMs'], 2400)
        self.assertEqual(result['artifacts'], {'transcript': 'raw', 'diarization': 'cam'})
        self.assertEqual(result['recognition']['identity'], generated_identity())
        self.assertEqual(result['recognition']['protocol'], contract.PROTOCOL)

    def test_duration_truncation_fails_even_when_all_recognized_characters_match(self):
        reference = {**self.reference, 'durationMs': 3000}
        run, result = self.run_evaluation(reference)
        self.assertEqual(run.returncode, 1, run.stderr)
        self.assertEqual(result['transcription']['characterErrorRate'], 0)
        self.assertEqual(result['status'], 'failed')

    def test_mismatched_native_checkpoints_cannot_be_graded_as_success(self):
        changed = copy.deepcopy(self.diarization)
        changed['output']['payload']['checkpoint']['sha256'] = 'a'*64
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE file_artifacts SET json=? WHERE kind='diarization'", (json.dumps(changed),))
        run, result = self.run_evaluation()
        self.assertNotEqual(run.returncode, 0)
        self.assertIsNone(result)
        self.assertIn('Checkpoint digest mismatch', run.stderr)

    def test_self_consistent_native_artifacts_from_a_different_audio_cannot_be_scored(self):
        raw, diarization = copy.deepcopy(self.raw), copy.deepcopy(self.diarization)
        checkpoint = contract.read_checkpoint(raw['output']['payload']['checkpoint'])
        checkpoint['source']['audioSha256'] = hashlib.sha256(b'another generated recording').hexdigest()
        archive = contract.archive_checkpoint(checkpoint)
        raw['output']['payload']['checkpoint'] = archive
        diarization['output']['payload']['checkpoint'] = archive
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE file_artifacts SET json=? WHERE kind='transcript'", (json.dumps(raw),))
            db.execute("UPDATE file_artifacts SET json=? WHERE kind='diarization'", (json.dumps(diarization),))
        run, result = self.run_evaluation()
        self.assertNotEqual(run.returncode, 0)
        self.assertIsNone(result)
        self.assertIn('does not belong to the reference audio', run.stderr)

    def test_speaker_text_errors_use_native_assignments_and_unknown_text_is_not_free(self):
        changed = copy.deepcopy(self.diarization)
        changed['output']['payload']['diarization']['assignments'] = [None, None, None]
        result = control.score_attributed_text(self.turns, self.transcript, changed, {'A': 'SPEAKER_9', 'B': 'SPEAKER_2'})
        self.assertEqual(result['characterErrorRate'], 2)
        self.assertEqual(result['unassignedOrExtraClusterCharacters'], result['referenceCharacters'])

    def test_correct_words_and_acoustics_cannot_hide_missing_sentence_attribution(self):
        changed = copy.deepcopy(self.diarization)
        changed['output']['payload']['diarization']['assignments'] = [None, None, None]
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE file_artifacts SET json=? WHERE kind='diarization'", (json.dumps(changed),))
        run, result = self.run_evaluation()
        self.assertEqual(run.returncode, 1, run.stderr)
        self.assertEqual(result['transcription']['characterErrorRate'], 0)
        self.assertEqual(result['speakerSeparation']['confusionFractionOnLabeledFrames'], 0)
        self.assertEqual(result['speakerAttributedTranscription']['characterErrorRate'], 2)

    def test_silence_requires_an_empty_complete_transcript_including_punctuation_only_hallucinations(self):
        source, identity = generated_source(2400), generated_identity()
        request = {'protocol': contract.PROTOCOL, 'operation': 'recognize', 'audioSha256': source['audioSha256'],
                   'maxAudioMs': 2400, 'identity': identity}
        for text in ('', '？！'):
            with self.subTest(text=text):
                rows = [{'startMs': 0, 'endMs': 2400, 'text': text}] if text else []
                native = {'text': text, 'sentence_info': [{'start': row['startMs'], 'end': row['endMs'], 'text': text} for row in rows]}
                recognition = contract.parse_response(contract.recognize_to_checkpoint(request, source, identity,
                    {'value': [[0, 2400]] if rows else []}, native, [{'text': text}] if rows else []))
                diarize = {**request, 'operation': 'diarize', 'checkpoint': recognition['checkpoint'], 'speakers': {'mode': 'unknown'}}
                response = contract.parse_response(contract.diarize_from_checkpoint(diarize, source, identity, lambda cp, options: {
                    'timeUnit': 'ms', 'speakers': options, 'assignments': [None]*len(rows), 'segments': [], 'samples': []}))
                raw = {'transcript': {'durationMs': 2400, 'segments': rows}, 'output': {'type': {'id': 'mote.funasr-transcript', 'version': '1'}, 'payload': recognition}}
                with sqlite3.connect(self.database) as db:
                    db.execute("UPDATE file_artifacts SET json=? WHERE kind='transcript'", (json.dumps(raw),))
                    db.execute("UPDATE file_artifacts SET json=? WHERE kind='diarization'", (json.dumps({'segments': [], 'output': {'payload': response}}),))
                (self.root/'quality.json').unlink(missing_ok=True)
                run, result = self.run_evaluation({**self.reference, 'turns': []})
                self.assertEqual(run.returncode, 1 if text else 0, run.stderr)
                self.assertEqual(result['status'], 'failed' if text else 'passed')


class GeneratedControlProvenance(unittest.TestCase):
    def test_generator_records_source_parameters_and_pcm_without_invoking_installed_voices(self):
        source = Path(__file__).with_name('generate-audio-control.py')
        spec = importlib.util.spec_from_file_location('generated_control', source)
        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)
        with tempfile.TemporaryDirectory(prefix='mote-generated-audio-control-') as temporary:
            output = Path(temporary)/'new-control'
            def command(args, **kwargs):
                if args[0] == 'git':
                    return subprocess.CompletedProcess(args, 0, stdout='a'*40+'\n')
                self.assertEqual(args[0], 'say')
                import wave
                with wave.open(args[args.index('-o')+1], 'wb') as audio:
                    audio.setnchannels(1)
                    audio.setsampwidth(2)
                    audio.setframerate(16000)
                    audio.writeframes(bytes(3200))
                return subprocess.CompletedProcess(args, 0)
            with patch.object(sys, 'argv', [str(source), '--output', str(output), '--gap-ms', '0']), patch.object(generator.subprocess, 'run', side_effect=command), patch.object(generator.platform, 'platform', return_value='generated-platform'):
                generator.main()
            reference = json.loads((output/'reference.json').read_text())
            self.assertEqual(reference['generation']['sourceCommit'], 'a'*40)
            self.assertEqual(reference['generation']['platform'], 'generated-platform')
            self.assertEqual(reference['generation']['wordsPerMinute'], 175)
            self.assertEqual(reference['durationMs'], 800)
            self.assertEqual(reference['turns'][-1]['endMs'], 800)
            self.assertEqual(reference['audioSha256'], hashlib.sha256((output/'two-voices.wav').read_bytes()).hexdigest())
            self.assertFalse(reference['personalDataUsed'])


if __name__ == '__main__':
    unittest.main()
