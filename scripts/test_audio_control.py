import importlib.util
from pathlib import Path
import unittest

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


if __name__ == '__main__':
    unittest.main()
