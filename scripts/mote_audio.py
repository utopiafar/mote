"""Offline PCM primitives used by the single-recording FunASR child.

No model loading, downloads, speaker naming or text correction occurs here.
"""
import base64
import hashlib
import io
import math
import os
from pathlib import Path
import socket
import subprocess
import wave

MAX_DIARIZATION_SEGMENTS = 100000
MAX_SPEAKER_LABELS = MAX_DIARIZATION_SEGMENTS
MAX_SPEAKER_PREVIEWS = 16
MAX_SAMPLE_BYTES = 768 * 1024


def offline_process():
    """Call only in the isolated inference child, never in the HTTP parent."""
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      HF_HUB_DISABLE_TELEMETRY='1', MODELSCOPE_OFFLINE='1',
                      DO_NOT_TRACK='1', PYTORCH_ENABLE_MPS_FALLBACK='0')
    def denied(*_args, **_kwargs):
        raise OSError('Network is disabled in the local audio worker')
    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied
    socket.getaddrinfo = denied


def normalize(source, destination, budget_ms, timeout=600):
    """Bound decoding by duration and wall clock, without trimming the timeline."""
    if Path(source).resolve() == Path(destination).resolve():
        raise ValueError('Original audio cannot be overwritten')
    if (type(budget_ms) not in (int, float) or not math.isfinite(budget_ms)
            or not 0 < budget_ms <= 86400000 or not 0 < timeout <= 3600):
        raise ValueError('Invalid normalization budget')
    formats = 'wav,mp3,mov,ogg,flac,aac,amr,aiff,matroska,webm,asf'
    command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
               '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats,
               '-i', str(source), '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '16000',
               '-t', str(budget_ms / 1000 + 1), '-c:a', 'pcm_s16le', '-n', str(destination)]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
    with wave.open(str(destination), 'rb') as reader:
        duration_ms = reader.getnframes() / 16
        if (reader.getnchannels() != 1 or reader.getframerate() != 16000
                or reader.getsampwidth() != 2 or reader.getcomptype() != 'NONE'):
            raise ValueError('Expected mono PCM16 at 16 kHz')
        if duration_ms > budget_ms:
            raise OverflowError('Audio duration exceeds budget')
    return duration_ms


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as reader:
        for block in iter(lambda: reader.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def read_pcm(normalized):
    with wave.open(str(normalized), 'rb') as reader:
        if (reader.getnchannels(), reader.getsampwidth(), reader.getframerate(), reader.getcomptype()) != (1, 2, 16000, 'NONE'):
            raise ValueError('Expected mono PCM16 at 16 kHz')
        frames = reader.getnframes()
        if frames > 1382400000:
            raise OverflowError('PCM exceeds duration limit')
        pcm = reader.readframes(frames)
        if len(pcm) != frames * 2:
            raise ValueError('Incomplete PCM input')
    return pcm


def frame_interval(start_ms, end_ms, frames):
    """Use original PCM coordinates once, with no rounding beyond the input."""
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in (start_ms, end_ms)):
        raise ValueError('Nonfinite audio interval')
    if not 0 <= start_ms < end_ms <= frames / 16:
        raise ValueError('Audio interval outside recording')
    start, end = int(start_ms * 16), int(end_ms * 16)
    if end <= start:
        raise ValueError('Audio interval contains no PCM frames')
    return start, end


def sample_bytes(normalized, start_ms, end_ms):
    with wave.open(str(normalized), 'rb') as reader:
        if (reader.getnchannels(), reader.getsampwidth(), reader.getframerate(), reader.getcomptype()) != (1, 2, 16000, 'NONE'):
            raise ValueError('Expected mono PCM16 at 16 kHz')
        start, end = frame_interval(start_ms, end_ms, reader.getnframes())
        if (end - start) * 2 + 44 > MAX_SAMPLE_BYTES:
            raise OverflowError('Audio preview exceeds byte limit')
        reader.setpos(start)
        pcm = reader.readframes(end - start)
        if len(pcm) != (end - start) * 2:
            raise ValueError('Incomplete PCM preview')
    output = io.BytesIO()
    with wave.open(output, 'wb') as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(16000)
        writer.writeframes(pcm)
    return output.getvalue()


def exclusive_sample(rows, speaker):
    """Choose an exclusive interval, including exclusion of unknown speech."""
    best = None
    candidates = sorted((r for r in rows if r['speaker'] == speaker),
                        key=lambda r: r['endMs'] - r['startMs'], reverse=True)[:20]
    for candidate in candidates:
        intervals = [(candidate['startMs'], candidate['endMs'])]
        for other in rows:
            if other['speaker'] == speaker or other['endMs'] <= candidate['startMs'] or other['startMs'] >= candidate['endMs']:
                continue
            intervals = [(a, b) for start, end in intervals
                         for a, b in [(start, min(end, other['startMs'])), (max(start, other['endMs']), end)] if b > a]
        for start, end in intervals:
            if best is None or end - start > best[1] - best[0]:
                best = (start, min(end, start + 12000))
    return best


def speaker_previews(normalized, rows):
    """A 16-preview budget never clips transcript rows or anonymous labels."""
    if len(rows) > MAX_DIARIZATION_SEGMENTS:
        raise OverflowError('Diarization output exceeds limit')
    labels = list(dict.fromkeys(row['speaker'] for row in rows if row['speaker'] is not None))
    if len(labels) > MAX_SPEAKER_LABELS:
        raise OverflowError('Diarization labels exceed limit')
    clips = []
    for speaker in labels:
        if len(clips) == MAX_SPEAKER_PREVIEWS:
            break
        interval = exclusive_sample(rows, speaker)
        if interval is None or interval[1] - interval[0] < 300:
            continue
        # Export exact frame boundaries so metadata describes the actual WAV.
        start, end = int(interval[0] * 16) / 16, int(interval[1] * 16) / 16
        clips.append({'speaker': speaker, 'startMs': start, 'endMs': end,
                      'wavBase64': base64.b64encode(sample_bytes(normalized, start, end)).decode('ascii')})
    return clips
