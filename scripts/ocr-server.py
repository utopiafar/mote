#!/usr/bin/env python3
"""Loopback-only, offline OCR worker. Model files are installed by Mote first."""
import argparse
import hmac
import io
import json
import os
import socket
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import BoundedSemaphore

class UnsupportedImage(Exception):
    pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-root', required=True)
    parser.add_argument('--port', type=int, default=9010)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('Invalid port')
    root = Path(args.model_root)
    secret = os.environ.get('MOTE_MEDIA_WORKER_TOKEN', '')
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1', PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK='True')
    busy = BoundedSemaphore(1)
    pipeline = None
    pipeline_marker = None

    def ready():
        return (root / 'complete.json').is_file() and all((root / name).is_file() for name in (
            'det/inference.onnx', 'det/inference.yml', 'rec/inference.onnx', 'rec/inference.yml'))

    def recognize(image):
        nonlocal pipeline, pipeline_marker
        from PIL import Image
        import numpy as np
        from paddlex.inference.pipelines import create_pipeline, load_pipeline_config
        Image.MAX_IMAGE_PIXELS = 40_000_000
        try:
            with Image.open(io.BytesIO(image)) as opened:
                if opened.format not in ('PNG', 'JPEG', 'WEBP') or opened.width * opened.height > 40_000_000 or max(opened.size) > 12000:
                    raise UnsupportedImage('Image format or dimensions unsupported')
                pixels = np.asarray(opened.convert('RGB'))
        except (ValueError, OSError) as error:
            raise UnsupportedImage('Image could not be decoded') from error
        stamp = (root / 'complete.json').stat().st_mtime_ns
        if pipeline is None or pipeline_marker != stamp:
            config = load_pipeline_config('OCR')
            config['use_doc_preprocessor'] = False
            config['use_textline_orientation'] = False
            config['SubModules']['TextDetection'].update(model_name='PP-OCRv5_mobile_det', model_dir=str(root / 'det'))
            config['SubModules']['TextRecognition'].update(model_name='PP-OCRv5_mobile_rec', model_dir=str(root / 'rec'))
            pipeline = create_pipeline(config=config, engine='onnxruntime', device='cpu')
            pipeline_marker = stamp
        segments = []
        for result in pipeline.predict(pixels):
            data = result.json.get('res', result.json)
            for value in data.get('rec_texts', []):
                line = str(value).strip()
                if line:
                    segments.append({'startMs': 0, 'endMs': 0, 'text': line[:8000]})
                if len(segments) > 50000:
                    raise ValueError('OCR result too large')
        return {'durationMs': 0, 'segments': segments, 'engine': 'PP-OCRv5-mobile-ONNX'}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def authorized(self):
            return bool(secret) and hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + secret)

        def send_json(self, value):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('X-Mote-Execution', 'local')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self.authorized():
                self.send_error(401)
            elif self.path == '/health':
                self.send_json({'version': 1, 'execution': 'local', 'ocr': ready()})
            else:
                self.send_error(404)

        def do_POST(self):
            if self.path != '/ocr':
                self.send_error(404)
                return
            if not self.authorized():
                self.send_error(401)
                return
            if not ready():
                self.send_error(503, 'Model not installed')
                return
            if not busy.acquire(blocking=False):
                self.send_error(429, 'OCR worker busy')
                return
            try:
                size = int(self.headers.get('Content-Length', '-1'))
                if not 0 < size <= 8 * 1024 * 1024:
                    self.send_error(413)
                    return
                image = self.rfile.read(size)
                if len(image) != size:
                    self.send_error(400)
                    return
                try:
                    self.send_json(recognize(image))
                except UnsupportedImage:
                    self.send_error(422, 'Unsupported image')
                except Exception:
                    self.send_error(503, 'OCR execution unavailable')
            finally:
                busy.release()

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    def denied(*_args, **_kwargs):
        raise OSError('Network is disabled in the local OCR worker')
    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied
    socket.getaddrinfo = denied
    server.serve_forever()


if __name__ == '__main__':
    main()
