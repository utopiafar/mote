"""Offline audio primitives shared by the central worker and deterministic tests.

Model APIs follow faster-whisper and sherpa-onnx's official Python examples.
No model downloads, remote inference, speaker naming, or term correction occur here.
"""
import base64
import io
import os
from pathlib import Path
import socket
import subprocess
import wave


def offline_process():
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')
    def denied(*_args, **_kwargs):
        raise OSError('Network is disabled in the local audio worker')
    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied
    socket.getaddrinfo = denied


def normalize(source, destination, budget_ms, timeout=600):
    """Bound decoding by both decoded duration and wall clock; never overwrite source."""
    if Path(source).resolve() == Path(destination).resolve():
        raise ValueError('Original audio cannot be overwritten')
    formats = 'wav,mp3,mov,ogg,flac,aac,amr,aiff,matroska,webm,asf'
    command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
               '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats,
               '-i', str(source), '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '16000',
               '-t', str(budget_ms / 1000 + 1), '-c:a', 'pcm_s16le', '-n', str(destination)]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
    with wave.open(str(destination), 'rb') as reader:
        duration_ms = reader.getnframes() * 1000 / reader.getframerate()
        if reader.getnchannels() != 1 or reader.getframerate() != 16000 or duration_ms > budget_ms:
            raise OverflowError('Audio duration exceeds budget')
    return duration_ms


def transcribe(normalized, model_path, threads):
    from faster_whisper import WhisperModel
    if not Path(model_path).is_dir():
        raise ValueError('A local ASR model directory is required')
    model = WhisperModel(str(model_path), device='cpu', compute_type='int8', cpu_threads=threads, local_files_only=True)
    segments, info = model.transcribe(str(normalized), beam_size=5, vad_filter=True,
                                     word_timestamps=True, condition_on_previous_text=False)
    result = []
    for segment in segments:
        if not segment.text.strip():
            continue
        words = [{'startMs': round(w.start * 1000), 'endMs': round(w.end * 1000),
                  'text': w.word, 'probability': max(0, min(1, w.probability))} for w in (segment.words or [])]
        result.append({'startMs': round(segment.start * 1000), 'endMs': round(segment.end * 1000),
                       'text': segment.text.strip(), 'words': words})
        if len(result) > 50000:
            raise OverflowError('Too many transcript segments')
    return {'durationMs': info.duration * 1000, 'segments': result,
            'engine': 'faster-whisper-local', 'uncorrected': True}


def sample_bytes(normalized, start_ms, end_ms):
    with wave.open(str(normalized), 'rb') as reader:
        reader.setpos(min(reader.getnframes(), int(start_ms * 16)))
        pcm = reader.readframes(int((end_ms - start_ms) * 16))
    output = io.BytesIO()
    with wave.open(output, 'wb') as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(16000)
        writer.writeframes(pcm)
    return output.getvalue()


def exclusive_sample(rows, speaker):
    """Choose an acoustically exclusive interval; never infer a person's identity."""
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


def diarize(normalized, segmentation_path, embedding_path, speaker_count, threads):
    import numpy as np
    import sherpa_onnx
    if not Path(segmentation_path).is_file() or not Path(embedding_path).is_file():
        raise ValueError('Local segmentation and speaker embedding models are required')
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segmentation_path)),
            num_threads=threads, provider='cpu'),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding_path), num_threads=threads, provider='cpu'),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=speaker_count or -1, threshold=0.5),
        min_duration_on=0.1, min_duration_off=0.3)
    if not config.validate():
        raise ValueError('Invalid local diarization models')
    with wave.open(str(normalized), 'rb') as reader:
        duration_ms = reader.getnframes() / 16
        samples = np.frombuffer(reader.readframes(reader.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    model = sherpa_onnx.OfflineSpeakerDiarization(config)
    if model.sample_rate != 16000:
        raise ValueError('Diarization model must accept 16 kHz')
    result = model.process(samples).sort_by_start_time()
    labels = {}
    rows = []
    for segment in result:
        if segment.speaker not in labels:
            labels[segment.speaker] = 'SPEAKER_' + str(len(labels))
        start, end = max(0, round(segment.start * 1000)), min(round(duration_ms), round(segment.end * 1000))
        if end > start:
            rows.append({'startMs': start, 'endMs': end, 'speaker': labels[segment.speaker]})
        if len(rows) > 100000 or len(labels) > 16:
            raise OverflowError('Diarization output exceeds limit')
    warnings = []
    if speaker_count and len(labels) != speaker_count:
        warnings.append('预期说话人数与识别结果不同；请试听并确认，不会补造说话人。')
    clips = []
    for speaker in labels.values():
        interval = exclusive_sample(rows, speaker)
        if not interval or interval[1] - interval[0] < 300:
            warnings.append(speaker + ' 没有足够长的独立发言可供试听。')
            continue
        start, end = interval
        clips.append({'speaker': speaker, 'startMs': start, 'endMs': end,
                      'wavBase64': base64.b64encode(sample_bytes(normalized, start, end)).decode('ascii')})
    return {'durationMs': duration_ms, 'engine': 'sherpa-onnx/pyannote-3.0+3D-Speaker',
            'expectedSpeakers': speaker_count or None, 'observedSpeakers': len(labels),
            'overlapDetection': 'unknown', 'segments': rows, 'samples': clips, 'warnings': warnings}
