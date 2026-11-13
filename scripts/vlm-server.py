#!/usr/bin/env python3
"""Loopback InternVL worker. CORE supplies --model-root and a private token.

GET /health; POST /v1/interpret (IMG-00 v1); POST /v1/cancel {operationId}.
Abort of an interpret HTTP connection also cancels the owned inference. SIGTERM
drains admission, reaps only the model child, then removes its private directory.
"""
import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import select
import signal
import socket
import threading

from mote_vlm import (MAX_REQUEST_BYTES, VlmError, VlmWorker, correlation, failure,
                      fields, loads, parse_request, serialize, text)


def create_server(worker, secret, port=0):
    if len(secret) < 32:
        raise ValueError('MOTE_MEDIA_WORKER_TOKEN must contain at least 32 characters')

    class Server(ThreadingHTTPServer):
        # Finish bounded in-flight HTTP replies after model termination, so a
        # normal SIGTERM cannot race the last cancelled/unavailable envelope.
        daemon_threads = False
        block_on_close = True

        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(10)
            return connection, address

    class Handler(BaseHTTPRequestHandler):
        # Close every connection: unread excess bytes never become a new request.
        protocol_version = 'HTTP/1.0'

        def log_message(self, *_):
            pass

        def authorized(self):
            return hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + secret)

        def reply(self, value, status=200):
            body = serialize(value)
            try:
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('X-Mote-Execution', 'local')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

        def reject(self, code, status):
            self.reply({'error': {'code': code}, 'executionStarted': False}, status)

        def do_GET(self):
            if not self.authorized():
                self.reject('unauthorized', 401)
            elif self.path == '/health':
                worker.prepare()
                self.reply(worker.health())
            else:
                self.reject('not_found', 404)

        def disconnected(self):
            try:
                if select.select([self.connection], [], [], 0)[0]:
                    return self.connection.recv(1, socket.MSG_PEEK) == b''
            except (ConnectionError, OSError):
                return True
            return False

        def do_POST(self):
            if not self.authorized():
                self.reject('unauthorized', 401)
                return
            if self.path not in ('/v1/interpret', '/v1/cancel'):
                self.reject('not_found', 404)
                return
            raw = None
            try:
                if (self.headers.get('Transfer-Encoding') is not None
                        or len(self.headers.get_all('Content-Length', [])) != 1
                        or self.headers.get_content_type() != 'application/json'):
                    raise VlmError('invalid_request')
                size = int(self.headers['Content-Length'])
                limit = MAX_REQUEST_BYTES if self.path == '/v1/interpret' else 4096
                if not 0 < size <= limit:
                    self.reject('invalid_request', 413)
                    return
                self.connection.settimeout(10)
                data = self.rfile.read(size)
                if len(data) != size:
                    raise VlmError('invalid_request')
                raw = loads(data)
                if self.path == '/v1/cancel':
                    fields(raw, ('operationId',))
                    text(raw['operationId'], 200, True)
                    self.reply({'version': 1, 'execution': 'local',
                                'cancellationRequested': worker.cancel(raw['operationId'])})
                    return
                request = parse_request(data)
                timeout = self.headers.get('X-Mote-Processing-Timeout-Ms')
                if timeout is not None:
                    timeout = int(timeout)
                    if not 1 <= timeout <= 3600000:
                        raise VlmError('invalid_request')
                    timeout /= 1000
                self.reply(worker.interpret(request, self.disconnected, timeout))
            except (VlmError, ValueError, TypeError, KeyError, socket.timeout) as error:
                code = error.code if isinstance(error, VlmError) else 'invalid_request'
                try:
                    correlation(raw)
                    self.reply(failure(raw, code))
                except (VlmError, TypeError, KeyError):
                    self.reject(code, 400)

    return Server(('127.0.0.1', port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-root', required=True, help='CORE-verified local-image directory')
    parser.add_argument('--port', type=int, default=9011)
    parser.add_argument('--timeout', type=int, default=180, help='Maximum request seconds, including a cold load')
    parser.add_argument('--load-timeout', type=int, default=180)
    parser.add_argument('--temporary-root', help='Existing private worker temporary parent (not a model cache)')
    args = parser.parse_args()
    if not 0 <= args.port <= 65535 or not 1 <= args.timeout <= 3600 or not 1 <= args.load_timeout <= 3600:
        parser.error('Invalid port or timeout')
    secret = os.environ.get('MOTE_MEDIA_WORKER_TOKEN', '')
    if len(secret) < 32:
        parser.error('MOTE_MEDIA_WORKER_TOKEN must contain at least 32 characters')
    worker = VlmWorker(args.model_root, temporary_root=args.temporary_root,
                       timeout=args.timeout, load_timeout=args.load_timeout)
    server = create_server(worker, secret, args.port)

    def stop(_signum, _frame):
        worker.stopping.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    worker.prepare()
    try:
        server.serve_forever(poll_interval=0.05)
    finally:
        worker.close()
        server.server_close()


if __name__ == '__main__':
    main()
