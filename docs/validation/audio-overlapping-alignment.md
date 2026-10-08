# Overlapping ASR sentences through retained-file processing

The accepted transcript contract allows overlapping sentences with monotonically
increasing sentence starts. Each sentence's words can be valid on their own while
expanding them in source order produces a backwards start at the next sentence.
Previously this failed alignment after transcription and diarization succeeded,
leaving the recording's overall job failed.

The alignment boundary now retains a whole sentence at its original sentence
time range when its final word starts after the next sentence starts. This uses
the existing sentence-level alignment path, forces uncertain speaker attribution
for that sentence, and adds a translated processing warning. Recognized words
are never sorted, dropped or rewritten and original timestamps are not shifted.

- KEEP: immutable originals and raw ASR, anonymous acoustic labels, time-based
  alignment, detected-overlap flags, existing sentence fallback and explicit
  uncertainty; no semantic classification or identity inference.
- CHANGE: sentence fallback also handles the validated cross-sentence word-time
  conflict, with uncertainty and a visible warning.
- REMOVE: backwards derived timelines for this accepted input shape.
- EXCEPTION: ordered, text-preserving word timings still use word-level alignment.
  ASR segment overlap alone does not establish simultaneous human speech.
- UNKNOWN: live ASR accuracy, acoustic label accuracy and semantic recall.

Generated regressions reproduce the old timeline rejection, verify text/order and
raw timestamps remain unchanged, and exercise retained-file upload, processing,
uncertain chunk publication and restart without repeating ASR or diarization.
Existing tests cover acoustic conflicts, unknown labels and preservation of
recognized evidence during optional semantic grouping. Private real-data
diagnostics and product retry outcomes are recorded outside Git; successful
schema validation is separate from listening accuracy.
