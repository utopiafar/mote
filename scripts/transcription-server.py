#!/usr/bin/env python3
"""Bounded offline ASR/diarization HTTP worker. See docs/file-processing.md."""
import argparse
import hmac
import json
import math
import importlib.util
import shutil
import multiprocessing
import os
from pathlib import Path
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from tempfile import TemporaryDirectory


def recognize(path, stage, settings, budget, speakers, sender):
    try:
        if hasattr(os, 'setsid'):
            os.setsid()
        from mote_audio import offline_process, normalize, transcribe, diarize
        offline_process()
        with TemporaryDirectory(prefix='mote-normalized-') as temporary:
            wav = Path(temporary) / 'normalized.wav'
            normalize(path, wav, budget, settings['timeout'])
            if stage == 'transcribe':
                body = transcribe(wav, settings['model'], settings['threads'])
            else:
                body = diarize(wav, settings['segmentation_model'], settings['speaker_model'], speakers, settings['threads'])
            result = json.dumps({'status': 200, 'body': body}, ensure_ascii=False).encode()
            if len(result) > 32 * 1024 * 1024:
                raise OverflowError('output limit')
            sender.send_bytes(result)
    except OverflowError:
        sender.send_bytes(b'{"status":413}')
    except Exception:
        sender.send_bytes(b'{"status":422}')
    finally:
        sender.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True, help='Local faster-whisper model directory')
    parser.add_argument('--segmentation-model', default='', help='Local pyannote segmentation ONNX file')
    parser.add_argument('--speaker-model', default='', help='Local 3D-Speaker embedding ONNX file')
    parser.add_argument('--port', type=int, default=9009)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--timeout', type=int, default=600)
    args = parser.parse_args()
    if not 1 <= args.threads <= 32 or not 1 <= args.timeout <= 3600 or not 1 <= args.port <= 65535:
        parser.error('Invalid threads, timeout or port')
    # The control endpoint stays available while models are being installed.
    settings = vars(args)
    secret = os.environ.get('MOTE_MEDIA_WORKER_TOKEN') or os.environ.get('MOTE_TRANSCRIPTION_TOKEN', '')
    mp = multiprocessing.get_context('spawn')
    busy = threading.BoundedSemaphore(1)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def authorized(self):
            return not secret or hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + secret)

        def json_response(self, body):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('X-Mote-Execution', 'local')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if not self.authorized():
                self.send_error(401)
            elif self.path == '/health':
                runtime = bool(shutil.which('ffmpeg') and importlib.util.find_spec('faster_whisper'))
                self.json_response({'version': 2, 'execution': 'local', 'asr': bool(runtime and Path(args.model).is_dir() and Path(args.model, 'model.bin').is_file()),
                                    'diarization': bool(runtime and importlib.util.find_spec('sherpa_onnx') and args.segmentation_model and args.speaker_model and
                                                        Path(args.segmentation_model).is_file() and Path(args.speaker_model).is_file())})
            else:
                self.send_error(404)

        def do_POST(self):
            if self.path not in ('/transcribe', '/diarize'):
                self.send_error(404)
                return
            if not self.authorized():
                self.send_error(401)
                return
            if not Path(args.model, 'model.bin').is_file() or not shutil.which('ffmpeg') or importlib.util.find_spec('faster_whisper') is None:
                self.send_error(503, 'Local ASR model or runtime unavailable')
                return
            if self.path == '/diarize' and (not Path(args.segmentation_model).is_file() or not Path(args.speaker_model).is_file() or importlib.util.find_spec('sherpa_onnx') is None):
                self.send_error(503, 'Local diarization model unavailable')
                return
            if not busy.acquire(blocking=False):
                self.send_error(429, 'Local worker busy')
                return
            worker = None
            released = False
            try:
                self.connection.settimeout(args.timeout)
                length = int(self.headers.get('Content-Length', '-1'))
                budget = min(float(self.headers.get('X-Mote-Max-Audio-Ms', '14400000')), 86400000)
                speakers = int(self.headers.get('X-Mote-Speaker-Count', '0'))
                if not 0 < length <= 512 * 1024 * 1024 or not math.isfinite(budget) or budget <= 0 or not 0 <= speakers <= 16:
                    self.send_error(413)
                    return
                with TemporaryDirectory(prefix='mote-audio-input-') as directory:
                    audio = Path(directory) / 'original.audio'
                    with audio.open('xb') as output:
                        remaining = length
                        while remaining:
                            block = self.rfile.read(min(1024 * 1024, remaining))
                            if not block:
                                raise ValueError('incomplete input')
                            output.write(block)
                            remaining -= len(block)
                    receiver, sender = mp.Pipe(duplex=False)
                    worker = mp.Process(target=recognize, args=(str(audio), self.path[1:], settings, budget, speakers, sender))
                    worker.start()
                    sender.close()
                    try:
                        if not receiver.poll(args.timeout):
                            self.send_error(504, 'Audio processing timeout')
                            return
                        response = json.loads(receiver.recv_bytes(32 * 1024 * 1024))
                    finally:
                        receiver.close()
                    if response['status'] != 200:
                        self.send_error(response['status'], 'Audio processing failed')
                        return
                    worker.join(5)
                    if worker.is_alive():
                        raise TimeoutError('Worker did not finish')
                    busy.release()
                    released = True
                    self.json_response(response['body'])
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self.send_error(422, 'Audio processing failed')
            finally:
                if worker is not None:
                    worker.join(0.2)
                    if worker.is_alive():
                        if hasattr(os, 'killpg'):
                            try:
                                os.killpg(worker.pid, signal.SIGTERM)
                            except ProcessLookupError:
                                worker.terminate()
                        else:
                            worker.terminate()
                        worker.join(5)
                        if worker.is_alive():
                            worker.kill()
                            worker.join()
                if not released:
                    busy.release()

    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
