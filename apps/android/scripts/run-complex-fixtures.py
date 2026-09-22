#!/usr/bin/env python3
"""Runs synthetic Android phases with real force-stop/offline/reconnect boundaries.

Build the selected app and androidTest APK first. Reads URL/token from a local JSON
connection file; never prints the token. Does not enable screen capture.
"""
import argparse
import json
import pathlib
import shlex
import subprocess
import sys
import urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument('--connection', type=pathlib.Path, required=True)
parser.add_argument('--serial', default='emulator-5580')
parser.add_argument('--adb', default=str(pathlib.Path.home() / 'Library/Android/sdk/platform-tools/adb'))
parser.add_argument('--rounds', type=int, choices=range(1, 11), default=3)
parser.add_argument('--output', type=pathlib.Path)
parser.add_argument('--build-type', choices=('debug', 'development'), default='development')
options = parser.parse_args()
android = pathlib.Path(__file__).resolve().parent.parent
output = options.output or android / 'app/build/reports/complex-fixtures'
output.mkdir(parents=True, exist_ok=True)
connection = json.loads(options.connection.read_text())
url = urllib.parse.urlparse(connection['url'])
if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost') or not url.port or url.path not in ('', '/') or url.username or url.query or url.fragment:
    raise SystemExit('A dedicated loopback HTTP fixture node is required.')
base = [options.adb, '-s', options.serial]

def adb(*args, check=True):
    result = subprocess.run([*base, *args], check=False, capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(f'ADB {args[0]} failed: {result.stderr.strip()}')
    return result.stdout.strip()

if adb('shell', 'getprop', 'ro.boot.qemu.avd_name') != 'mote_fixture_api35':
    raise SystemExit('Refusing to run outside the dedicated synthetic fixture AVD.')
package = 'dev.mote.collector.dev' if options.build_type == 'development' else 'dev.mote.collector'
for path in (android / f'app/build/outputs/apk/{options.build_type}/app-{options.build_type}.apk', android / f'app/build/outputs/apk/androidTest/{options.build_type}/app-{options.build_type}-androidTest.apk'):
    adb('install', '-r', str(path))

class_name = 'dev.mote.collector.ComplexNotesInstrumentedTest'
port = f'tcp:{url.port}'
try:
    for round_number in range(1, options.rounds + 1):
        adb('reverse', '--remove', port, check=False)
        for phase in ('stageOfflineComplexNotesAndPreparedRetry', 'recoverOfflinePreparedRetry', 'synchronizeAndCompareCentralEvidence'):
            adb('shell', 'am', 'force-stop', package)
            adb('shell', 'am', 'force-stop', package + '.test')
            if phase == 'synchronizeAndCompareCentralEvidence':
                adb('reverse', port, port)
            arguments = ['am', 'instrument', '-w', '-r', '-e', 'class', f'{class_name}#{phase}',
                '-e', 'fixtureRound', str(round_number), '-e', 'fixtureServer', connection['url'],
                '-e', 'fixtureToken', connection['token'], f'{package}.test/androidx.test.runner.AndroidJUnitRunner']
            command = [*base, 'shell', shlex.join(arguments)]
            log = output / f'round-{round_number}-{phase}.log'
            with log.open('w') as stream:
                result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, timeout=240)
            content = log.read_text()
            if result.returncode or 'OK (1 test)' not in content or 'INSTRUMENTATION_STATUS_CODE: -4' in content:
                raise RuntimeError(f'Round {round_number} {phase} failed; see {log}')
            print(f'Round {round_number}: {phase} passed', flush=True)
        result = adb('exec-out', 'run-as', package, 'cat', f'files/complex-notes-result-{round_number}.json')
        (output / f'round-{round_number}-evidence.json').write_text(result + '\n')
    print(f'{options.rounds} synthetic rounds passed. Metadata/digests: {output}')
finally:
    adb('shell', 'am', 'force-stop', package, check=False)
    adb('shell', 'am', 'force-stop', package + '.test', check=False)
    adb('reverse', '--remove', port, check=False)
