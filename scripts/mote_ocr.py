"""Bounded geometric image preparation for the offline OCR processor.

Tile ownership uses the center of PaddleX rec_polys, never recognized words.
Repeated text at different positions is therefore preserved.
"""
import io
import math

MAX_PIXELS = 40_000_000
CORE_SIDE = 2048
OVERLAP = 128
MAX_TILES = 64


class UnsupportedImage(Exception):
    pass


def image_tiles(width, height):
    if width < 1 or height < 1 or width * height > MAX_PIXELS:
        raise UnsupportedImage('Image dimensions unsupported')
    columns, rows = math.ceil(width / CORE_SIDE), math.ceil(height / CORE_SIDE)
    if columns * rows > MAX_TILES:
        raise UnsupportedImage('Too many image tiles')
    for top in range(0, height, CORE_SIDE):
        for left in range(0, width, CORE_SIDE):
            right, bottom = min(left + CORE_SIDE, width), min(top + CORE_SIDE, height)
            yield ((max(0, left - OVERLAP), max(0, top - OVERLAP),
                    min(width, right + OVERLAP), min(height, bottom + OVERLAP)),
                   (left, top, right, bottom))


def owned_lines(data, crop, core, tiled):
    texts, polygons = data.get('rec_texts', []), data.get('rec_polys', [])
    if tiled and len(texts) != len(polygons):
        raise ValueError('Tiled OCR requires aligned text geometry')
    for index, value in enumerate(texts):
        line = str(value).strip()
        if not line:
            continue
        x, y = 0, index
        if index < len(polygons):
            polygon = polygons[index]
            if (len(polygon) != 4 or any(len(point) != 2 for point in polygon)
                    or any(not math.isfinite(value) for point in polygon for value in point)):
                raise ValueError('Invalid OCR text geometry')
            x = sum(point[0] for point in polygon) / 4 + crop[0]
            y = sum(point[1] for point in polygon) / 4 + crop[1]
            if not (core[0] <= x < core[2] and core[1] <= y < core[3]):
                continue
        yield y, x, {'startMs': 0, 'endMs': 0, 'text': line[:8000]}


def recognize_image(image, predict):
    from PIL import Image
    import numpy as np
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(io.BytesIO(image)) as opened:
            if opened.format not in ('PNG', 'JPEG', 'WEBP'):
                raise UnsupportedImage('Image format unsupported')
            tiles = list(image_tiles(opened.width, opened.height))
            pixels = opened.convert('RGB')
    except (ValueError, OSError, Image.DecompressionBombError) as error:
        raise UnsupportedImage('Image could not be decoded') from error
    segments = []
    try:
        for crop, core in tiles:
            with pixels.crop(crop) as tile:
                for result in predict(np.asarray(tile)):
                    data = result.json.get('res', result.json)
                    for segment in owned_lines(data, crop, core, len(tiles) > 1):
                        segments.append(segment)
                        if len(segments) > 50000:
                            raise ValueError('OCR result too large')
    finally:
        pixels.close()
    # Preserve the existing model order for a single image; order vertical
    # screenshot tiles by position, without collapsing repeated strings.
    if len(tiles) > 1:
        segments.sort(key=lambda segment: (segment[0], segment[1]))
    return {'durationMs': 0, 'segments': [segment[2] for segment in segments],
            'engine': 'PP-OCRv5-mobile-ONNX'}
