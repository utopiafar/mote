#!/usr/bin/env python3
"""Optional central CPU ASR worker. See docs/files.md for the raw HTTP contract."""
import argparse
import hmac
import json
import math
import multiprocessing
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from tempfile import NamedTemporaryFile


def recognize(path, model_path, threads, budget, sender):
    """One disposable decoder/model process; the parent enforces a wall-clock limit."""
    try:
        import av
        from faster_whisper import WhisperModel
        with av.open(path) as container:
            if container.duration is None:
                sender.send_bytes(json.dumps({'status': 422}).encode())
                return
            duration_ms = container.duration / 1000
            if duration_ms > budget:
                sender.send_bytes(json.dumps({'status': 413}).encode())
                return
        model = WhisperModel(model_path, device='cpu', compute_type='int8', cpu_threads=threads, local_files_only=True)
        segments, info = model.transcribe(path, beam_size=5, vad_filter=True)
        rows = []
        for segment in segments:
            if segment.text.strip():
                rows.append({'startMs': round(segment.start * 1000), 'endMs': round(segment.end * 1000), 'text': segment.text.strip()})
            if len(rows) > 50000:
                raise ValueError('output limit')
        body = {'durationMs': max(duration_ms, info.duration * 1000), 'segments': rows}
        result = json.dumps({'status': 200, 'body': body}, ensure_ascii=False).encode()
        if len(result) > 32 * 1024 * 1024:
            raise ValueError('output limit')
        sender.send_bytes(result)
    except Exception:
        sender.send_bytes(b'{"status":422}')
    finally:
        sender.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True, help='Local faster-whisper model directory; no automatic downloads')
    parser.add_argument('--port', type=int, default=9009)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--timeout', type=int, default=600, help='Maximum seconds per decoder/model process')
    args = parser.parse_args()
    if not 1 <= args.threads <= 32 or not 1 <= args.timeout <= 3600:
        parser.error('threads must be 1..32 and timeout 1..3600')
    secret = os.environ.get('MOTE_TRANSCRIPTION_TOKEN', '')
    mp = multiprocessing.get_context('spawn')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            if self.path != '/transcribe':
                self.send_error(404)
                return
            if secret and not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + secret):
                self.send_error(401)
                return
            worker = None
            try:
                self.connection.settimeout(args.timeout)
                length = int(self.headers.get('Content-Length', '-1'))
                budget = min(float(self.headers.get('X-Mote-Max-Audio-Ms', '14400000')), 86400000)
                if not 0 < length <= 512 * 1024 * 1024 or not math.isfinite(budget) or budget <= 0:
                    self.send_error(413)
                    return
                with NamedTemporaryFile(prefix='mote-asr-') as audio:
                    remaining = length
                    while remaining:
                        block = self.rfile.read(min(1024 * 1024, remaining))
                        if not block:
                            raise ValueError('incomplete input')
                        audio.write(block)
                        remaining -= len(block)
                    audio.flush()
                    receiver, sender = mp.Pipe(duplex=False)
                    worker = mp.Process(target=recognize, args=(audio.name, args.model, args.threads, budget, sender))
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
                    result = json.dumps(response['body'], ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(result)))
                self.end_headers()
                self.wfile.write(result)
            except Exception:
                self.send_error(422, 'Audio processing failed')
            finally:
                if worker is not None:
                    if worker.is_alive():
                        worker.terminate()
                    worker.join(5)
                    if worker.is_alive():
                        worker.kill()
                        worker.join()

    HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
