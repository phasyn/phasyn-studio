"""Phasyn Studio media tools: ffprobe/FFmpeg subprocesses, streaming encode, mux and PTS sampling (no torch).

- ``phasyn_media.tools``: find_ffmpeg / find_ffprobe / list_encoders and the only subprocess runner
  (argv only, own process group, timeout, cancel, bounded output, minimal environment)
- ``phasyn_media.limits``: MediaLimits, DEFAULT_LIMITS
- ``phasyn_media.errors``: MediaError, MediaCanceled
- ``phasyn_media.probe``: probe(path) -> MediaInfo
- ``phasyn_media.encode``: StreamingVideoEncoder (bounded queue, back-pressure, supervised FFmpeg)
- ``phasyn_media.audio``: write_wav_f32 / read_wav_header
- ``phasyn_media.mux``: mux(...) -> MuxResult
- ``phasyn_media.capabilities``: encoder capability detection and codec routing
- ``phasyn_media.frames``: frame sampling by real PTS (``video.describe``)
- ``phasyn_media.effects``: sequence clip effects (transitions, fades, speed, volume, colour, titles):
  parsing, frame counts and filtergraphs
- ``phasyn_media.composition``: the plan of a multitrack export (clips, text, segments, limits, refusals);
  ``composition_video`` / ``composition_audio`` build the graph of one segment / one audio chunk
- ``phasyn_media.seek``: frame- and sample-accurate input seeking (pure arithmetic)
- ``phasyn_media.text``: titles and captions drawn without a browser (FreeType, HarfBuzz and fontconfig in a
  bounded child process)
- ``phasyn_media.scenes``: shot-change detection (FFmpeg ``select`` scene scores)
- ``phasyn_media.soundtrack``: a sequence's external audio track: source timeline, length plan, filtergraph
- ``phasyn_media.testing``: helpers for test suites that run a real FFmpeg

Importing the package has no side effects and starts no process.
"""

__all__ = [
    "audio",
    "capabilities",
    "composition",
    "effects",
    "encode",
    "errors",
    "frames",
    "limits",
    "mux",
    "probe",
    "scenes",
    "seek",
    "soundtrack",
    "testing",
    "text",
    "tools",
]
