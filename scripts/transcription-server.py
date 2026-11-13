#!/usr/bin/env python3
"""Bounded loopback FunASR worker; execution facts remain content-free.

CORE owns the listener process. Each readiness probe or recording gets one
private process group, watched by its multiprocessing parent sentinel. Only the
HTTP owner may report a terminated result, after reaping that entire group.
"""
import argparse
from email.message import Message
from email.parser import BytesHeaderParser
import hashlib
import hmac
import importlib
import json
import math
import multiprocessing
from multiprocessing.connection import wait
import os
from pathlib import Path
import platform
import re
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import mote_asr_contract as contract
from mote_execution_facts import ExecutionFacts, execution_status, erase_execution

AUDIO_BYTES = 512 * 1024 * 1024
HEADER_BYTES = 8192
BODY_BYTES = AUDIO_BYTES + contract.LIMITS['wireBytes'] + 2 * HEADER_BYTES + 1024


class Rejected(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status


def _group_running(pgid):
    # Darwin can report EPERM rather than ESRCH for a just-reaped group. Inspect
    # only the owned group, with no command lines / environment / private data.
    # A Linux zombie is also already dead even if init has not collected it yet.
    result = subprocess.run(['/bin/ps', '-o', 'stat=', '-g', str(pgid)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=2, check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError('Could not verify owned audio process group')
    return any(row.strip() and not row.strip().startswith(b'Z') for row in result.stdout.splitlines())


def stop_recognizer(worker):
    """Reap this recognizer AND its private FFmpeg group, even after leader exit."""
    if worker is None or worker.pid is None:
        return

    def stop_group(sig):
        if hasattr(os, 'killpg'):
            try:
                os.killpg(worker.pid, sig)
                return
            except ProcessLookupError:
                pass  # It may not have reached setsid yet.
            except PermissionError:
                if _group_running(worker.pid):
                    raise
        if worker.is_alive():
            worker.kill() if sig == signal.SIGKILL else worker.terminate()

    stop_group(signal.SIGTERM)
    worker.join(2)
    stop_group(signal.SIGKILL)
    worker.join()
    # join() only waits for the leader. Wait for its remaining group as well;
    # reporting terminated while FFmpeg is still alive would be false evidence.
    if hasattr(os, 'killpg'):
        deadline = time.monotonic()+3
        while True:
            try:
                os.killpg(worker.pid, 0)
            except ProcessLookupError:
                break
            except PermissionError:
                if not _group_running(worker.pid):
                    break
                raise
            if time.monotonic() >= deadline:
                if not _group_running(worker.pid):
                    break
                raise RuntimeError('Owned audio process group did not exit')
            time.sleep(.01)


def _kill_orphan(directory):
    # Only this child's private workspace. No output can survive as a response
    # after its HTTP owner dies. FFmpeg inherits our group, including ignored TERM.
    shutil.rmtree(directory, ignore_errors=True)
    if hasattr(os, 'killpg'):
        os.killpg(os.getpid(), signal.SIGKILL)
    os._exit(1)


def _parent_watch(directory):
    parent = multiprocessing.parent_process()
    if parent is not None:
        wait([parent.sentinel])
        _kill_orphan(directory)


def _child(connection, directory, settings, request, started_at):
    """Small IPC notifications; large JSON travels through a bounded local file.

    A partial Pipe.send_bytes must never make the HTTP deadline/cancel loop
    block in recv_bytes. The child stays alive until its owner reaps the group,
    so its parent watcher also covers descendants after a completed response.
    """
    if hasattr(os, 'setsid'):
        os.setsid()
    threading.Thread(target=_parent_watch, args=(directory,), daemon=True).start()
    # SDK/FFmpeg diagnostics must not put recordings, paths or credentials in
    # exception logs. The wire carries fixed domain codes, never exception text.
    with open(os.devnull, 'wb') as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    tempfile.tempdir = directory
    os.environ.update(TMPDIR=directory, TMP=directory, TEMP=directory)
    os.environ.pop('MOTE_MEDIA_WORKER_TOKEN', None)
    running = False
    try:
        from mote_audio import offline_process
        offline_process()
        engine = importlib.import_module('mote_funasr')
        if request is None:
            models = engine.verify_models(settings['model_root'])
            runtime = engine.SdkRuntime(settings['backend'], settings['threads'])
            try:
                # Prove all four components can actually load. Directory or
                # installation receipts alone do not supply this evidence.
                for role in contract.MODEL_IDS:
                    with runtime.component(role, Path(settings['model_root']) / role):
                        pass
                identity = {'sdkVersion': contract.SDK_VERSION, 'sdkWheelSha256': contract.SDK_WHEEL_SHA256,
                            **contract.PINS, 'settingsFingerprint': engine.SETTINGS_FINGERPRINT,
                            'models': models, 'dependencies': runtime.versions,
                            'backend': settings['backend'], 'threads': settings['threads']}
                contract.validate_identity(identity)
                wire = contract.serialize(identity)
            finally:
                runtime.close()
        else:
            # Admission has validated bytes, pinned identity and loaded health.
            # Keep accepted and running distinct, and commit started before the
            # child is allowed to enter run_audio (normalization included).
            connection.send_bytes(b'ready')
            remaining = contract.loads(connection.recv_bytes(256))['timeout']
            running = True
            wire = engine.run_audio(request, Path(directory) / 'original.audio', settings['model_root'],
                                    backend=settings['backend'], threads=settings['threads'],
                                    timeout=remaining, started_at=started_at)
        data = wire.encode('utf-8') if isinstance(wire, str) else wire
        if len(data) > contract.LIMITS['wireBytes']:
            raise OverflowError()
        if request is not None:
            contract.parse_response(data, request)
        Path(directory, 'response.json').write_bytes(data)
        connection.send_bytes(b'complete')
    except BaseException as error:
        code = getattr(error, 'code', None)
        if code not in contract.FAILURES:
            code = 'output_limit' if isinstance(error, OverflowError) else 'component_missing' if isinstance(error, ImportError) else 'inference_failed'
        # No new failure vocabulary or untrusted exception messages on the wire.
        connection.send_bytes(contract.serialize({'code': code, 'running': running}).encode())
    finally:
        # Parent EOF is also observed if the parent exits between notifications.
        try:
            connection.recv_bytes(16)
        except (EOFError, OSError):
            # Do not depend on the daemon watcher winning a race with child
            # exit after a broken notification. Synchronously kill our group.
            _kill_orphan(directory)
        connection.close()


class OwnedChild:
    def __init__(self, context, directory, settings, request):
        self.connection, child_connection = context.Pipe(duplex=True)
        self.worker = context.Process(target=_child, args=(child_connection, directory, settings, request, time.monotonic()))
        self.lock = threading.Lock()
        try:
            self.worker.start()
        except BaseException:
            self.connection.close()
            raise
        finally:
            child_connection.close()

    def close(self):
        with self.lock:
            stop_recognizer(self.worker)
            self.connection.close()


def _signature(root):
    """Invalidate load evidence on any of the engine's required file changes.

    The engine remains the only asset/hash authority; no duplicate catalog or
    complete.json reader. A matching stat signature only reuses a successful
    actual load probe, and is never sufficient for first readiness.
    """
    try:
        engine = importlib.import_module('mote_funasr')
    except (ImportError, OSError):
        return None, 'component_missing'
    signature = []
    try:
        for role in contract.MODEL_IDS:
            for item in engine.component_manifest(role)['files']:
                path = Path(root) / role / item['name']
                info = path.stat()
                if not path.is_file():
                    return None, 'model_missing'
                signature.append((str(path), info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino))
    except (OSError, ValueError):
        return None, 'model_missing'
    return tuple(signature), None


class AudioWorker:
    def __init__(self, settings, facts):
        self.settings, self.facts = settings, facts
        self.context = multiprocessing.get_context('spawn')
        self.lock = threading.RLock()
        self.stopping = threading.Event()
        self.busy = False
        self.loading = False
        self.children = set()
        self.identity = None
        self.signature = None
        self.error = 'worker_not_ready'
        self.probe_at = 0
        self.probe_thread = None

    def spawn(self, directory, request=None, deadline=None):
        with self.lock:
            if self.stopping.is_set():
                raise InterruptedError()
            child = OwnedChild(self.context, directory, {**self.settings, 'deadline': deadline}, request)
            self.children.add(child)
            return child

    def reap(self, child):
        if child is not None:
            child.close()
            with self.lock:
                self.children.discard(child)

    def _probe(self, signature):
        child = None
        identity, error = None, 'worker_not_ready'
        try:
            with tempfile.TemporaryDirectory(prefix='mote-asr-load-', dir=self.settings.get('temporary_root')) as directory:
                child = self.spawn(directory)
                deadline = time.monotonic() + self.settings['load_timeout']
                while not self.stopping.is_set() and time.monotonic() < deadline:
                    if child.connection.poll(.05):
                        notice = child.connection.recv_bytes(4096)
                        if notice == b'complete':
                            identity = contract.loads(Path(directory, 'response.json').read_bytes())
                            contract.validate_identity(identity)
                            error = None
                        else:
                            error = contract.loads(notice)['code']
                        break
                    if not child.worker.is_alive():
                        break
                self.reap(child)
                child = None
        except Exception:
            error, identity = 'worker_not_ready', None
        finally:
            self.reap(child)
            with self.lock:
                current, _ = _signature(self.settings['model_root'])
                if not self.stopping.is_set() and current == signature:
                    self.identity, self.signature, self.error = identity, signature, error
                self.loading = False
                self.probe_at = time.monotonic()

    def health(self, prepare=True):
        with self.lock:
            signature, missing = _signature(self.settings['model_root'])
            ffmpeg = bool(shutil.which('ffmpeg'))
            if signature != self.signature or missing:
                self.identity = None
            if missing:
                self.error = missing
            elif (ffmpeg and prepare and not self.identity and not self.busy and not self.loading
                  and not self.stopping.is_set() and (signature != self.signature or time.monotonic()-self.probe_at >= 5)):
                self.loading = True
                self.probe_thread = threading.Thread(target=self._probe, args=(signature,), daemon=True)
                self.probe_thread.start()
            ready = bool(ffmpeg and self.identity and not self.stopping.is_set())
            dependencies = {'ffmpeg': ffmpeg, 'funasr': missing != 'component_missing' and self.error != 'component_missing'}
            result = {'version': 1, 'protocol': contract.PROTOCOL, 'execution': 'local',
                      'asr': ready, 'diarization': ready, 'wespeaker': False,
                      'busy': self.busy, 'loading': self.loading, 'dependencies': dependencies,
                      'missingDependencies': [name for name, available in dependencies.items() if not available]}
            if ready:
                result['identity'] = self.identity
            elif not self.loading:
                result['reason'] = self.error if ffmpeg else 'component_missing'
                result['loadError'] = self.error not in ('model_missing', 'component_missing', 'worker_not_ready')
            return result

    @contextmanager
    def admission(self):
        with self.lock:
            if self.stopping.is_set():
                raise Rejected('worker_not_ready', 503)
            if self.busy:
                raise Rejected('resource_busy', 429)
            health = self.health()
            if not health['asr']:
                code = 'component_missing' if not health['dependencies']['ffmpeg'] else self.error if self.error in ('model_missing', 'component_missing') and not self.loading else 'worker_not_ready'
                raise Rejected(code, 503)
            self.busy = True
        try:
            yield health['identity']
        finally:
            with self.lock:
                self.busy = False

    def close(self):
        self.stopping.set()
        with self.lock:
            children = tuple(self.children)
        for child in children:
            self.reap(child)
        if self.probe_thread is not None:
            self.probe_thread.join()


class Multipart:
    """Fixed-length, streaming two-part input. Never buffer the audio in RAM."""
    def __init__(self, handler, size, boundary, deadline, stopping):
        self.handler, self.remaining, self.boundary = handler, size, boundary
        self.deadline, self.stopping = deadline, stopping
        self.buffer = b''

    def fill(self):
        if self.stopping.is_set():
            raise InterruptedError()
        remaining_time = self.deadline-time.monotonic()
        if remaining_time <= 0:
            raise Rejected('invalid_input', 408)
        self.handler.connection.settimeout(min(1, remaining_time))
        # The handler uses an unbuffered reader: select must observe every byte,
        # including short bodies read in the same packet as the HTTP headers.
        if not select.select([self.handler.connection], [], [], min(.1, remaining_time))[0]:
            return
        block = self.handler.rfile.read(min(64*1024, self.remaining))
        if not block:
            raise Rejected('invalid_input')
        self.remaining -= len(block)
        self.buffer += block

    def until(self, marker, limit, output, delimiter=False):
        size = 0
        while True:
            at = self.buffer.find(marker)
            if at >= 0:
                if delimiter:
                    while len(self.buffer) < at+len(marker)+2 and self.remaining:
                        self.fill()
                    # A boundary prefix inside arbitrary audio is ordinary
                    # data unless followed by the actual MIME delimiter.
                    if self.buffer[at+len(marker):at+len(marker)+2] not in (b'\r\n', b'--'):
                        count = at+1
                        size += count
                        if size > limit:
                            raise Rejected('invalid_input', 413)
                        output(self.buffer[:count])
                        self.buffer = self.buffer[count:]
                        continue
                block, self.buffer = self.buffer[:at], self.buffer[at+len(marker):]
                if size + len(block) > limit:
                    raise Rejected('invalid_input', 413)
                output(block)
                return
            count = max(0, len(self.buffer)-len(marker)-(1 if delimiter else -1))
            if count:
                size += count
                if size > limit:
                    raise Rejected('invalid_input', 413)
                output(self.buffer[:count])
                self.buffer = self.buffer[count:]
            if not self.remaining:
                raise Rejected('invalid_input')
            self.fill()

    def take(self, size):
        while len(self.buffer) < size:
            if not self.remaining:
                raise Rejected('invalid_input')
            self.fill()
        block, self.buffer = self.buffer[:size], self.buffer[size:]
        return block

    def read(self, audio):
        if self.take(len(self.boundary)+4) != b'--'+self.boundary+b'\r\n':
            raise Rejected('invalid_input')
        seen, request = set(), None
        sha = hashlib.sha256()
        for _ in range(2):
            blocks = []
            self.until(b'\r\n\r\n', HEADER_BYTES, blocks.append)
            headers = BytesHeaderParser().parsebytes(b''.join(blocks)+b'\r\n\r\n')
            if (headers.defects or {key.lower() for key in headers.keys()}-{'content-disposition', 'content-type'}
                    or len(headers.get_all('Content-Disposition', [])) != 1
                    or len(headers.get_all('Content-Type', [])) != 1
                    or headers.get_content_disposition() != 'form-data'):
                raise Rejected('invalid_input')
            name = headers.get_param('name', header='Content-Disposition')
            if name not in ('request', 'audio') or name in seen:
                raise Rejected('invalid_input')
            seen.add(name)
            if headers.get_content_type() != ('application/json' if name == 'request' else 'application/octet-stream'):
                raise Rejected('invalid_input')
            if name == 'request':
                if headers.get_content_charset('utf-8').lower() != 'utf-8':
                    raise Rejected('invalid_input')
                blocks = []
                self.until(b'\r\n--'+self.boundary, contract.LIMITS['wireBytes'], blocks.append, True)
                try:
                    request = contract.parse_request(b''.join(blocks))
                except (ValueError, TypeError, KeyError, UnicodeError):
                    raise Rejected('contract_mismatch')
            else:
                with audio.open('xb') as output:
                    os.chmod(audio, 0o600)
                    def write(block):
                        output.write(block)
                        sha.update(block)
                    self.until(b'\r\n--'+self.boundary, AUDIO_BYTES, write, True)
            if self.take(2) != (b'--' if len(seen) == 2 else b'\r\n'):
                raise Rejected('invalid_input')
        if self.take(2) != b'\r\n' or self.buffer or self.remaining:
            raise Rejected('invalid_input')
        if request is None or audio.stat().st_size == 0 or sha.hexdigest() != request['audioSha256']:
            raise Rejected('invalid_input')
        return request


def create_server(worker, secret, port=0):
    class Server(ThreadingHTTPServer):
        daemon_threads = False
        block_on_close = True

        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(10)
            return connection, address

        def handle_error(self, *_):
            # No raw exception, request data, path or secret in HTTP logs.
            pass

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.0'
        rbufsize = 0

        def log_message(self, *_):
            pass

        def authorized(self):
            return bool(secret) and hmac.compare_digest(self.headers.get('Authorization', '').encode('utf-8'), ('Bearer '+secret).encode('utf-8'))

        def json_response(self, body, status=200, unstarted=False):
            data = contract.serialize(body).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('X-Mote-Execution', 'local')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Connection', 'close')
            if unstarted:
                self.send_header('X-Mote-Execution-Started', 'false')
            if getattr(self, 'receipt_id', None):
                self.send_header('X-Mote-Receipt-Id', self.receipt_id)
            if body.get('code') == 'resource_busy':
                self.send_header('Retry-After', '5')
            self.end_headers()
            self.wfile.write(data)

        def failure(self, operation, code, status=200):
            body = contract.loads(contract.worker_failure(operation, code))
            self.json_response(body, status, body['execution'] == 'not_started')

        def do_GET(self):
            if not self.authorized():
                self.send_error(401)
            elif execution_status(self, worker.facts):
                pass
            elif self.path == '/health':
                self.json_response(worker.health())
            else:
                self.send_error(404)

        def disconnected(self):
            try:
                return bool(select.select([self.connection], [], [], 0)[0] and self.connection.recv(1, socket.MSG_PEEK) == b'')
            except OSError:
                return True

        def do_POST(self):
            operation = {'/transcribe': 'recognize', '/diarize': 'diarize'}.get(self.path)
            if operation is None:
                self.send_error(404)
                return
            if not self.authorized():
                self.failure(operation, 'invalid_input', 401)
                return
            request_id, scope = self.headers.get('X-Mote-Request-Id', ''), self.headers.get('X-Mote-Request-Scope', '')
            if (request_id or scope) and not worker.facts.identity(request_id, scope):
                self.failure(operation, 'invalid_input', 400)
                return
            child, accepted, started, response = None, False, False, None
            code, status, disconnected = 'inference_failed', 200, False
            try:
                if self.headers.get('Transfer-Encoding') is not None or len(self.headers.get_all('Content-Length', [])) != 1:
                    raise Rejected('invalid_input', 411)
                value = self.headers['Content-Length']
                if not re.fullmatch(r'[0-9]{1,10}', value) or not 0 < int(value) <= BODY_BYTES:
                    raise Rejected('invalid_input', 413)
                content = Message()
                content['Content-Type'] = self.headers.get('Content-Type', '')
                boundary = content.get_boundary()
                if (len(self.headers.get_all('Content-Type', [])) != 1 or content.get_content_type() != 'multipart/form-data'
                        or not boundary or not re.fullmatch(r"[0-9A-Za-z'()+_,./:=?-]{1,70}", boundary)):
                    raise Rejected('invalid_input')
                timeout = self.headers.get('X-Mote-Processing-Timeout-Ms')
                if timeout is not None and (not re.fullmatch('[0-9]{4,7}', timeout) or not 1000 <= int(timeout) <= 3600000):
                    raise Rejected('invalid_input')
                timeout = min(worker.settings['timeout'], int(timeout)/1000) if timeout is not None else worker.settings['timeout']
                deadline = time.monotonic()+timeout
                budget = float(self.headers.get('X-Mote-Max-Audio-Ms', str(contract.LIMITS['durationMs'])))
                if not math.isfinite(budget) or budget < 1:
                    raise Rejected('invalid_input')
                with worker.admission() as identity:
                    with tempfile.TemporaryDirectory(prefix='mote-asr-request-', dir=worker.settings.get('temporary_root')) as directory:
                        request = Multipart(self, int(value), boundary.encode('ascii'), deadline, worker.stopping).read(Path(directory)/'original.audio')
                        if request['operation'] != operation or request['identity'] != identity:
                            raise Rejected('contract_mismatch')
                        request['maxAudioMs'] = min(request['maxAudioMs'], budget, worker.settings['max_audio_ms'])
                        if operation == 'diarize' and contract.read_checkpoint(request['checkpoint'])['source']['durationMs'] > request['maxAudioMs']:
                            raise Rejected('invalid_input')
                        if not worker.health(prepare=False)['asr']:
                            raise Rejected('worker_not_ready', 503)
                        if self.disconnected():
                            return
                        if request_id:
                            if not worker.facts.begin(request_id, scope, self.path[1:]):
                                self.failure(operation, 'invalid_input', 409)
                                return
                            accepted, self.receipt_id = True, request_id
                        child = worker.spawn(directory, request, deadline)
                        try:
                            while True:
                                if worker.stopping.is_set():
                                    raise InterruptedError()
                                if time.monotonic() >= deadline:
                                    code = 'inference_timeout'
                                    break
                                # Prefer an already completed response to a late
                                # disconnect: a lost body is not a failed run.
                                if child.connection.poll(.025):
                                    notice = child.connection.recv_bytes(4096)
                                    if notice == b'ready':
                                        if self.disconnected():
                                            disconnected, code = True, 'cancelled'
                                            break
                                        if accepted:
                                            worker.facts.started(request_id)
                                        started = True
                                        # Send a duration, not a cross-process
                                        # absolute clock. Python <3.10 on macOS
                                        # has process-local monotonic origins.
                                        child.connection.send_bytes(contract.serialize({'timeout': max(.001, deadline-time.monotonic())}).encode())
                                    elif notice == b'complete':
                                        with Path(directory, 'response.json').open('rb') as output:
                                            data = output.read(contract.LIMITS['wireBytes']+1)
                                        response = contract.parse_response(data, request)
                                        break
                                    else:
                                        code = contract.loads(notice)['code']
                                        break
                                elif not child.worker.is_alive():
                                    break
                                if self.disconnected():
                                    disconnected, code = True, 'cancelled'
                                    break
                        except (EOFError, OSError, ValueError, TypeError, KeyError):
                            code, response = 'inference_failed', None
                        finally:
                            # Neither a result nor a terminal fact may escape
                            # before recognizer and normalization children exit.
                            worker.reap(child)
                            child = None
                        if worker.stopping.is_set():
                            return  # Restart reports unknown; never fake failure.
                        if time.monotonic() >= deadline:
                            # Parsing and physical termination are part of the
                            # bounded call too. A completed model body cannot
                            # turn a late, un-reaped child into full success.
                            response, code = None, 'inference_timeout'
                        if response is not None:
                            if response['status'] == 'succeeded':
                                if accepted:
                                    worker.facts.finish(request_id, True)
                            else:
                                code = response['code']
                        if accepted and not (response and response['status'] == 'succeeded') and contract.FAILURES[code][1] == 'terminated':
                            worker.facts.finish(request_id, False, 'processing_timeout' if code == 'inference_timeout' else 'unsupported_input' if code in ('unsupported_input', 'output_limit') else 'processing_failed')
                        # A late pre-inference dependency loss is not a genuine
                        # recognition failure. Leave its receipt unresolved for
                        # the existing restart/unknown recovery, rather than
                        # fabricate a terminal failed attempt in shared facts.
            except Rejected as error:
                code, status = error.code, error.status
            except (BrokenPipeError, ConnectionResetError):
                disconnected = True
            except (TimeoutError, socket.timeout):
                code, status = ('inference_timeout', 200) if started else ('invalid_input', 408)
            except InterruptedError:
                return
            except Exception:
                code = 'inference_failed' if accepted else 'invalid_input'
            finally:
                worker.reap(child)
            if not disconnected:
                # Physical cleanup and the admission context both finish before
                # the caller can receive a terminal body and reuse capacity.
                if response is not None and response['status'] == 'succeeded':
                    self.json_response(response)
                else:
                    self.failure(operation, code, status)

        def do_DELETE(self):
            if not self.authorized():
                self.send_error(401)
            else:
                erase_execution(self, worker.facts)

    return Server(('127.0.0.1', port), Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-root', required=True, help='Installed dialogue directory with all four FunASR components')
    parser.add_argument('--backend', choices=('cpu', 'mps'), default='mps' if platform.system() == 'Darwin' and platform.machine() == 'arm64' else 'cpu')
    parser.add_argument('--port', type=int, default=9009)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--load-timeout', type=int, default=120)
    parser.add_argument('--max-audio-ms', type=int, default=contract.LIMITS['durationMs'])
    parser.add_argument('--temporary-root', help='Private parent for disposable request/probe workspaces')
    args = parser.parse_args()
    if (not 1 <= args.threads <= 32 or not 1 <= args.timeout <= 3600 or not 0 <= args.port <= 65535
            or not 1 <= args.load_timeout <= 3600 or not 1 <= args.max_audio_ms <= contract.LIMITS['durationMs']):
        parser.error('Invalid worker limits')
    facts = ExecutionFacts(Path(args.model_root).parent/'execution-facts', 'asr')
    worker = AudioWorker(vars(args), facts)
    secret = os.environ.get('MOTE_MEDIA_WORKER_TOKEN', '')
    server = create_server(worker, secret, args.port)
    stopping = threading.Event()

    def stop(*_):
        stopping.set()

    for kind in (signal.SIGTERM, signal.SIGINT):
        signal.signal(kind, stop)
    # handle_request keeps signal shutdown on the main thread, while all model
    # work and slow uploads stay in bounded handlers / owned child groups.
    server.timeout = .1
    owner = os.getppid()
    print(json.dumps({'port': server.server_port}), flush=True)
    try:
        while not stopping.is_set() and os.getppid() == owner:
            server.handle_request()
    finally:
        worker.close()
        server.server_close()
        facts.close()


if __name__ == '__main__':
    main()
