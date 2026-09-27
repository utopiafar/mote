"""Geometric fixtures, no model or personal screenshot dependencies."""
import unittest
from mote_ocr import image_tiles, owned_lines, UnsupportedImage, CORE_SIDE, OVERLAP


class ImagePreparation(unittest.TestCase):
    def test_long_phone_image_is_covered_without_global_downscaling(self):
        tiles = list(image_tiles(1200, 14825))
        self.assertEqual(len(tiles), 8)
        self.assertEqual(sum((right-left)*(bottom-top) for _, (left, top, right, bottom) in tiles), 1200*14825)
        self.assertTrue(all(crop[3]-crop[1] <= CORE_SIDE+2*OVERLAP for crop, _ in tiles))
        self.assertEqual(tiles[0][1], (0, 0, 1200, 2048))
        self.assertEqual(tiles[-1][1][3], 14825)

    def test_border_text_is_owned_once_and_distinct_repetitions_survive(self):
        lines = [(2047, 'same words'), (2048, 'same words'), (3500, 'same words')]
        found = []
        for crop, core in image_tiles(1200, 4000):
            visible = [(y, text) for y, text in lines if crop[1]+20 <= y < crop[3]-20]
            data = {'rec_texts': [text for _, text in visible],
                    'rec_polys': [[[100, y-crop[1]-10], [200, y-crop[1]-10],
                                   [200, y-crop[1]+10], [100, y-crop[1]+10]] for y, _ in visible]}
            found.extend(owned_lines(data, crop, core, True, (1200, 4000)))
        self.assertEqual([(y, segment['text']) for y, _, segment in sorted(found)], lines)
        for y, _, segment in found:
            self.assertEqual(segment['imageLocation'], {'width': 1200, 'height': 4000,
                             'polygon': [[100.0, y-10], [200.0, y-10], [200.0, y+10], [100.0, y+10]]})

    def test_oversized_or_pathologically_thin_images_remain_bounded(self):
        for width, height in [(0, 100), (10000, 10000), (1, 1_000_000)]:
            with self.assertRaises(UnsupportedImage):
                list(image_tiles(width, height))

    def test_tiled_output_requires_geometry_not_text_deduplication(self):
        crop, core = next(image_tiles(1000, 3000))
        with self.assertRaises(ValueError):
            list(owned_lines({'rec_texts': ['unlocated text']}, crop, core, True, (1000, 3000)))
        segment = list(owned_lines({'rec_texts': ['single image']}, crop, core, False, (1000, 3000)))[0][2]
        self.assertEqual(segment['text'], 'single image')
        self.assertNotIn('imageLocation', segment)

    def test_invalid_geometry_fails_instead_of_silently_dropping_text(self):
        crop, core = next(image_tiles(1000, 3000))
        for polygon in [[], [[0, 0]]*3, [[float('nan'), 0]]*4]:
            with self.assertRaises(ValueError):
                list(owned_lines({'rec_texts': ['generated'], 'rec_polys': [polygon]}, crop, core, True, (1000, 3000)))


if __name__ == '__main__':
    unittest.main()
