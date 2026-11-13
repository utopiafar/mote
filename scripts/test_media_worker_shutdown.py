"""Owned recognizer shutdown must also reap its normalization subprocess."""
import importlib.util
import http.client
import json
import multiprocessing
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

spec = importlib.util.spec_from_file_location('media_transcription', Path(__file__).with_name('transcription-server.py'))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def generated_recognizer(folder):
    os.setsid()
    code = "import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,lambda *_:None);Path('ready').write_text(str(os.getpid()));time.sleep(0.8);Path('late').write_text('late');time.sleep(30)"
    subprocess.Popen([sys.executable, '-c', code], cwd=folder, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(30)


@unittest.skipUnless(hasattr(os, 'setsid'), 'POSIX process groups')
class MediaShutdownTests(unittest.TestCase):
    def test_parent_exit_does_not_leave_normalization_child_running(self):
        with tempfile.TemporaryDirectory(prefix='mote-owned-media-') as folder:
            worker = multiprocessing.get_context('spawn').Process(target=generated_recognizer, args=(folder,))
            worker.start()
            pid = None
            try:
                for _ in range(200):
                    ready = Path(folder, 'ready')
                    if ready.exists():
                        pid = int(ready.read_text())
                        break
                    time.sleep(0.01)
                self.assertIsNotNone(pid)
                server.stop_recognizer(worker)
                self.assertFalse(worker.is_alive())
                time.sleep(1)
                self.assertFalse(Path(folder, 'late').exists())
            finally:
                server.stop_recognizer(worker)
                if pid:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


@unittest.skipUnless(hasattr(os, 'setsid'), 'POSIX process groups')
class TranscriptionProcessShutdownTests(unittest.TestCase):
    """Use the actual HTTP entrypoint, not a direct call to the stop helper."""
    def fixture(self, **options):
        from test_transcription_server import WorkerFixture
        fixture = WorkerFixture(**options)
        self.addCleanup(fixture.close)
        return fixture

    def running_ffmpeg(self, fixture):
        from test_transcription_server import until
        request, audio = fixture.request()
        (fixture.root/'mode').write_text('ffmpeg')
        request_id = str(uuid.uuid4())
        stream = fixture.raw(request, audio, request_id)
        self.addCleanup(stream.close)
        until(lambda: (fixture.root/'ffmpeg.pid').exists(), 'generated FFmpeg child')
        recognizer = int((fixture.root/'entered').read_text())
        ffmpeg = int((fixture.root/'ffmpeg.pid').read_text())
        self.assertEqual(fixture.fact(request_id)['state'], 'running')
        return request_id, recognizer, ffmpeg, stream

    def assert_reaped(self, *pids):
        from test_transcription_server import until, pid_alive
        for pid in pids:
            until(lambda: not pid_alive(pid), 'owned process exit '+str(pid))
            self.assertFalse(pid_alive(pid))

    def test_http_disconnect_reaps_recognizer_and_term_ignoring_ffmpeg_before_slot_reuse(self):
        from test_transcription_server import until
        fixture = self.fixture()
        request_id, recognizer, ffmpeg, stream = self.running_ffmpeg(fixture)
        stream.close()
        until(lambda: fixture.fact(request_id)['state'] == 'failed', 'terminal disconnect receipt')
        self.assert_reaped(recognizer, ffmpeg)
        self.assertEqual(list(fixture.scratch.iterdir()), [])
        (fixture.root/'mode').write_text('success')
        request, audio = fixture.request()
        response = fixture.post(request, audio)
        self.assertEqual(response[0], 200)
        self.assertEqual(json.loads(response[2])['status'], 'succeeded')

    def test_http_timeout_proves_both_children_gone_before_terminal_response(self):
        fixture = self.fixture(timeout=1)
        request_id, recognizer, ffmpeg, stream = self.running_ffmpeg(fixture)
        response = http.client.HTTPResponse(stream)
        response.begin()
        body = json.loads(response.read())
        self.assertEqual(body['code'], 'inference_timeout')
        self.assertEqual(body['execution'], 'terminated')
        self.assert_reaped(recognizer, ffmpeg)
        self.assertEqual(fixture.fact(request_id)['failureCode'], 'processing_timeout')
        self.assertEqual(list(fixture.scratch.iterdir()), [])

    def test_recognizer_crash_still_reaps_its_detached_output_ffmpeg_descendant(self):
        fixture = self.fixture()
        request, audio = fixture.request()
        (fixture.root/'mode').write_text('crash-with-ffmpeg')
        request_id = str(uuid.uuid4())
        result = fixture.post(request, audio, request_id)
        body = json.loads(result[2])
        self.assertEqual((body['code'], body['execution']), ('inference_failed', 'terminated'))
        self.assert_reaped(fixture.runs()[0]['pid'], int((fixture.root/'ffmpeg.pid').read_text()))
        self.assertEqual(fixture.fact(request_id)['state'], 'failed')
        self.assertEqual(list(fixture.scratch.iterdir()), [])

    def test_sigterm_and_sigint_stop_owned_groups_and_restart_reports_unknown_not_failed(self):
        for kind in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=kind):
                fixture = self.fixture()
                request_id, recognizer, ffmpeg, stream = self.running_ffmpeg(fixture)
                fixture.stop(kind)
                self.assert_reaped(recognizer, ffmpeg)
                self.assertEqual(list(fixture.scratch.iterdir()), [])
                stream.close()
                fixture.start()
                fact = fixture.fact(request_id)
                self.assertEqual((fact['state'], fact['outcome']), ('unknown', 'worker_restarted'))
                self.assertNotIn('finishedAt', fact)
                self.assertNotIn('failureCode', fact)
                fixture.stop()

    def test_abrupt_http_parent_exit_does_not_orphan_private_recognizer_or_ffmpeg_group(self):
        fixture = self.fixture()
        request_id, recognizer, ffmpeg, stream = self.running_ffmpeg(fixture)
        fixture.stop(signal.SIGKILL)
        self.assert_reaped(recognizer, ffmpeg)
        stream.close()
        fixture.start()
        fact = fixture.fact(request_id)
        self.assertEqual((fact['state'], fact['outcome']), ('unknown', 'worker_restarted'))
        self.assertEqual(len(fixture.runs()), 1, 'restart only reads facts; it does not replay the recording')

    def test_shutdown_during_four_component_load_reaps_loader_and_cleans_its_private_workspace(self):
        from test_transcription_server import until
        fixture = self.fixture()
        (fixture.root/'hold-load').touch()
        fixture.health()
        until(lambda: (fixture.root/'load-asr').exists(), 'loading child')
        loader = int((fixture.root/'load-asr').read_text())
        fixture.stop()
        self.assert_reaped(loader)
        self.assertEqual(list(fixture.scratch.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
