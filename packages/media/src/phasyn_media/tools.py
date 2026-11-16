"""FFmpeg/ffprobe discovery and the only subprocess runner of this package.

Rules enforced here for every child process:

- argv lists only (``shell=False``); no user text is ever interpreted by a shell;
- each child runs in its own process group (``start_new_session``) so cancel or
  timeout terminates the whole tree, and only trees this module started;
- every wait has a timeout; stdout/stderr are drained concurrently and bounded
  (stderr keeps a tail, stdout overflows are a hard error);
- a minimal environment is passed (no tokens/proxies/``FFREPORT``);
- callers add ``-protocol_whitelist file,pipe``/``-format_whitelist`` and a
  ``file:`` prefix to inputs, so FFmpeg never opens URLs or playlists.
"""

from __future__ import annotations

import functools
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

from phasyn_components.runtime_env import ENV_FFMPEG, ENV_FFPROBE

from .errors import MediaCanceled, MediaError, cancel_requested

# environment variables forwarded to FFmpeg children (everything else is dropped)
_ENV_PASSTHROUGH = ("PATH", "LD_LIBRARY_PATH", "TMPDIR", "SYSTEMROOT")
_ENV_PREFIX_PASSTHROUGH = ("CUDA_", "NVIDIA_", "__NV_")
_POLL_INTERVAL = 0.02


# --------------------------------------------------------------------------- discovery


def _validate_executable(candidate: str, env_name: str) -> str:
    path = os.path.abspath(candidate)
    if not os.path.isfile(path) or not os.access(path, os.X_OK):
        # The base name only: an error that reaches a run never carries a local path
        raise MediaError("MEDIA_TOOL_FAILED", f"{os.path.basename(path)} 不是可執行檔（來源：{env_name} 或 PATH）")
    return path


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def _resolve_tool(env_name: str, default_name: str, sibling_of: str | None = None) -> str:
    raw = _env(env_name)
    if raw:
        if "://" in raw:
            raise MediaError("INVALID_ARGUMENT", f"{env_name} 必須是本機路徑")
        if os.sep not in raw:
            found = shutil.which(raw)
            if found is None:
                raise MediaError("MEDIA_TOOL_FAILED", f"找不到 {env_name} 指定的工具：{raw}")
            return _validate_executable(found, env_name)
        return _validate_executable(os.path.expanduser(raw), env_name)
    found = shutil.which(default_name)
    if found is None and sibling_of is not None:
        sibling = os.path.join(os.path.dirname(sibling_of), default_name)
        if os.path.isfile(sibling):
            found = sibling
    if found is None:
        raise MediaError("MEDIA_TOOL_FAILED", f"找不到 {default_name}；請安裝 FFmpeg 或設定 {env_name}")
    return _validate_executable(found, env_name)


def find_ffmpeg() -> str:
    """Absolute path of ffmpeg (``PHASYN_FFMPEG``, else PATH)."""
    return _resolve_tool(ENV_FFMPEG, "ffmpeg")


def find_ffprobe() -> str:
    """Absolute path of ffprobe (``PHASYN_FFPROBE``, else PATH, else next to ffmpeg)."""
    sibling = None
    if _env(ENV_FFMPEG):
        try:
            sibling = find_ffmpeg()
        except MediaError:
            sibling = None
    return _resolve_tool(ENV_FFPROBE, "ffprobe", sibling_of=sibling)


def tool_env(extra: Mapping[str, str] | None = None) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k in _ENV_PASSTHROUGH or k.startswith(_ENV_PREFIX_PASSTHROUGH)}
    env.setdefault("PATH", os.defpath)
    env["LC_ALL"] = "C"
    env["AV_LOG_FORCE_NOCOLOR"] = "1"
    if extra:
        env.update(extra)
    return env


# --------------------------------------------------------------------------- process supervision


class BoundedTail:
    """Thread-safe bounded capture: the first bytes (root cause) plus the last ``limit`` bytes."""

    def __init__(self, limit: int) -> None:
        self._limit = max(1024, int(limit))
        self._head_limit = min(16 * 1024, self._limit // 4)
        self._head = bytearray()
        self._buf = bytearray()
        self._dropped = 0
        self._lock = threading.Lock()

    def feed(self, chunk: bytes) -> None:
        with self._lock:
            room = self._head_limit - len(self._head)
            if room > 0:
                self._head += chunk[:room]
                chunk = chunk[room:]
            self._buf += chunk
            excess = len(self._buf) - self._limit
            if excess > self._limit:  # amortized trimming
                del self._buf[:excess]
                self._dropped += excess

    def text(self) -> str:
        with self._lock:
            head = bytes(self._head)
            tail = bytes(self._buf[-self._limit :])
            dropped = self._dropped + max(0, len(self._buf) - self._limit)
        joiner = b"\n...\n" if dropped else b""
        return (head + joiner + tail).decode("utf-8", errors="replace")


def redact(text: str, replacements: Mapping[str, str] | None) -> str:
    """Replace local paths by placeholders (diagnostics never echo local paths)."""
    if not replacements:
        return text
    for needle, placeholder in sorted(replacements.items(), key=lambda kv: -len(kv[0])):
        if needle:
            text = text.replace(needle, placeholder)
    return text


_INFORMATIVE = re.compile(
    r"error|fail|not support|unsupported|required|invalid|cannot|could not|no .*device|out of memory|denied|"
    r"not found|whitelist|too (?:old|large|small)",
    re.IGNORECASE,
)
_LOG_PREFIX = re.compile(r"\[[^\]]*@ 0x[0-9a-fA-F]+\]\s*")


def summarize_stderr(text: str, max_chars: int = 800) -> str:
    """Root-cause-first summary of FFmpeg stderr (first informative lines, de-duplicated).

    FFmpeg prints the cause first (e.g. "Driver does not support the required
    nvenc API version") and the consequences last, so a plain tail hides it.
    """
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    picked = [line for line in lines if _INFORMATIVE.search(line)] or lines[-5:]
    out: list[str] = []
    for line in picked:
        clean = _LOG_PREFIX.sub("", line).strip()
        if clean and clean not in out:
            out.append(clean)
    summary = "；".join(out)
    return summary if len(summary) <= max_chars else summary[:max_chars] + "…"


class ManagedProcess:
    """A child process in its own process group with a bounded stderr tail.

    ``poll`` and ``kill_tree`` share one lock: the child is never reaped
    between "is it still running?" and ``killpg``, so a recycled PID/PGID of an
    unrelated process can never be signalled.
    """

    def __init__(
        self,
        argv: Sequence[str],
        *,
        stdin: int | IO[Any] | None = subprocess.DEVNULL,
        stdout: int | IO[Any] | None = subprocess.DEVNULL,
        env: Mapping[str, str] | None = None,
        max_stderr_bytes: int = 64 * 1024,
    ) -> None:
        if isinstance(argv, (str, bytes)) or not all(isinstance(a, str) for a in argv):
            raise MediaError("INVALID_ARGUMENT", "子程序參數必須是字串清單")
        self.argv = tuple(argv)
        self._lock = threading.Lock()
        self._stderr = BoundedTail(max_stderr_bytes)
        try:
            self._proc = subprocess.Popen(  # argv list, never a shell
                list(self.argv),
                stdin=stdin,
                stdout=stdout,
                stderr=subprocess.PIPE,
                start_new_session=True,
                close_fds=True,
                env=dict(env) if env is not None else tool_env(),
                shell=False,
            )
        except OSError as exc:
            raise MediaError("MEDIA_TOOL_FAILED", f"無法啟動 {os.path.basename(self.argv[0])}：{exc.strerror}") from exc
        self._stderr_thread = threading.Thread(target=self._drain_stderr, name="media-stderr", daemon=True)
        self._stderr_thread.start()

    @property
    def pid(self) -> int:
        return self._proc.pid

    @property
    def stdin(self) -> IO[bytes] | None:
        return self._proc.stdin

    @property
    def stdout(self) -> IO[bytes] | None:
        return self._proc.stdout

    @property
    def returncode(self) -> int | None:
        return self._proc.returncode

    def _drain_stderr(self) -> None:
        stream = self._proc.stderr
        if stream is None:
            return
        try:
            while True:
                chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
                if not chunk:
                    break
                self._stderr.feed(chunk)
        except (OSError, ValueError):
            pass

    def poll(self) -> int | None:
        with self._lock:
            return self._proc.poll()

    def wait(self, timeout: float | None) -> int | None:
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            rc = self.poll()
            if rc is not None:
                return rc
            if deadline is not None and time.monotonic() >= deadline:
                return None
            time.sleep(_POLL_INTERVAL)

    def kill_tree(self, *, wait_seconds: float = 5.0) -> int | None:
        """SIGKILL the child's process group (idempotent) and reap the child."""
        with self._lock:
            if self._proc.poll() is None:
                try:
                    os.killpg(self._proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    try:
                        self._proc.kill()
                    except ProcessLookupError:
                        pass
        return self.wait(wait_seconds)

    def stderr_text(self) -> str:
        return self._stderr.text()

    def close(self, *, join_seconds: float = 2.0) -> None:
        for stream in (self._proc.stdin, self._proc.stdout):
            if stream is not None:
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass
        self._stderr_thread.join(join_seconds)
        if self._proc.stderr is not None:
            try:
                self._proc.stderr.close()
            except (OSError, ValueError):
                pass


@dataclass
class _DrainState:
    bytes: int = 0
    overflow: bool = False
    sink_error: Exception | None = None


@dataclass(frozen=True)
class ToolResult:
    argv: tuple[str, ...]
    returncode: int
    stdout: bytes
    stdout_bytes: int
    stderr: str
    elapsed_seconds: float


def run_tool(
    argv: Sequence[str],
    *,
    timeout: float,
    cancel: Any = None,
    max_stdout_bytes: int = 16 * 1024 * 1024,
    max_stderr_bytes: int = 64 * 1024,
    stdout_sink: Callable[[bytes], None] | None = None,
    env: Mapping[str, str] | None = None,
    stdin_data: bytes | None = None,
    stdout_fd: int | None = None,
    what: str = "FFmpeg",
) -> ToolResult:
    """Run a tool to completion with timeout, cancel and bounded output.

    With ``stdout_sink`` stdout is streamed to the callback and only counted;
    otherwise it is collected up to ``max_stdout_bytes`` (overflow kills the
    tree and raises ``RESOURCE_EXHAUSTED``).  ``stdin_data`` is written by a
    helper thread and stdin is closed afterwards (EOF).  With ``stdout_fd`` the
    tool writes straight into that descriptor (the stdin pipe of another
    supervised process): nothing is collected here and the reader of the pipe
    is what bounds it.
    """
    started = time.monotonic()
    proc = ManagedProcess(
        argv,
        stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE if stdout_fd is None else stdout_fd,
        env=env,
        max_stderr_bytes=max_stderr_bytes,
    )
    writer: threading.Thread | None = None
    if stdin_data is not None:

        def feed_stdin() -> None:
            stream = proc.stdin
            if stream is None:
                return
            try:
                stream.write(stdin_data)
                stream.flush()
            except (OSError, ValueError):
                pass
            finally:
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass

        writer = threading.Thread(target=feed_stdin, name="media-stdin", daemon=True)
        writer.start()
    collected = bytearray()
    state = _DrainState()

    def drain_stdout() -> None:
        stream = proc.stdout
        if stream is None:
            return
        try:
            while True:
                chunk = stream.read1(1 << 20) if hasattr(stream, "read1") else stream.read(1 << 20)
                if not chunk:
                    break
                state.bytes += len(chunk)
                if stdout_sink is not None:
                    try:
                        stdout_sink(chunk)
                    except Exception as exc:  # stop the tool, report below
                        state.sink_error = exc
                        break
                elif len(collected) + len(chunk) > max_stdout_bytes:
                    state.overflow = True
                    break
                else:
                    collected.extend(chunk)
        except (OSError, ValueError):
            pass

    reader = threading.Thread(target=drain_stdout, name="media-stdout", daemon=True)
    if stdout_fd is None:
        reader.start()
    try:
        deadline = started + timeout
        while True:
            rc = proc.poll()
            if rc is not None:
                break
            if cancel_requested(cancel):
                proc.kill_tree()
                raise MediaCanceled(f"{what} 已因取消而終止")
            if state.overflow or state.sink_error is not None:
                proc.kill_tree()
                break
            if time.monotonic() >= deadline:
                proc.kill_tree()
                raise MediaError("MEDIA_TOOL_FAILED", f"{what} 執行逾時（{timeout:.0f} 秒）")
            time.sleep(_POLL_INTERVAL)
        if reader.is_alive():
            reader.join(timeout=10.0)
    finally:
        proc.kill_tree(wait_seconds=5.0)
        if reader.is_alive():
            reader.join(timeout=5.0)
        if writer is not None:
            writer.join(timeout=5.0)
        proc.close()
    if state.overflow:
        raise MediaError("RESOURCE_EXHAUSTED", f"{what} 輸出超過 {max_stdout_bytes} bytes 上限")
    if state.sink_error is not None:
        error = state.sink_error
        if isinstance(error, MediaError):
            raise error
        raise MediaError("MEDIA_TOOL_FAILED", f"{what} 輸出處理失敗：{error}")
    rc = proc.returncode
    return ToolResult(
        argv=proc.argv,
        returncode=-1 if rc is None else int(rc),
        stdout=bytes(collected),
        stdout_bytes=state.bytes,
        stderr=proc.stderr_text(),
        elapsed_seconds=time.monotonic() - started,
    )


# --------------------------------------------------------------------------- tool facts (cached)


def _stat_key(path: str) -> tuple[str, int, int]:
    """Cache key of a tool binary: its real path, mtime and size (an upgraded binary is re-read)."""
    st = os.stat(path)
    return (os.path.realpath(path), st.st_mtime_ns, st.st_size)


@dataclass(frozen=True)
class EncoderInfo:
    name: str
    media: str  # video | audio | subtitle
    codec: str
    description: str
    experimental: bool


_ENCODER_LINE = re.compile(r"^\s*([VAS])([F.])([S.])([X.])([B.])([D.])\s+(\S+)\s+(.*)$")
_CODEC_IN_DESC = re.compile(r"\(codec (\S+?)\)\s*$")


def parse_encoders(text: str) -> dict[str, EncoderInfo]:
    """Parse ``ffmpeg -encoders`` output (lines after the ``------`` separator)."""
    out: dict[str, EncoderInfo] = {}
    started = False
    for line in text.splitlines():
        if not started:
            started = line.strip().startswith("------")
            continue
        match = _ENCODER_LINE.match(line)
        if match is None:
            continue
        kind, _f, _s, experimental, _b, _d, name, desc = match.groups()
        codec_match = _CODEC_IN_DESC.search(desc)
        out[name] = EncoderInfo(
            name=name,
            media={"V": "video", "A": "audio", "S": "subtitle"}[kind],
            codec=codec_match.group(1) if codec_match else name,
            description=desc.strip(),
            experimental=experimental == "X",
        )
    return out


@functools.lru_cache(maxsize=16)
def _encoders_cached(key: tuple[str, int, int]) -> tuple[tuple[str, EncoderInfo], ...]:
    result = run_tool([key[0], "-hide_banner", "-nostdin", "-encoders"], timeout=15.0, max_stdout_bytes=4 << 20)
    if result.returncode != 0:
        raise MediaError("MEDIA_TOOL_FAILED", "無法列出 FFmpeg encoders")
    parsed = parse_encoders(result.stdout.decode("utf-8", errors="replace"))
    if not parsed:
        raise MediaError("MEDIA_TOOL_FAILED", "FFmpeg encoders 清單無法解析")
    return tuple(sorted(parsed.items()))


def list_encoders(ffmpeg: str | None = None) -> dict[str, EncoderInfo]:
    """Encoders compiled into this ffmpeg build (parsed once per binary)."""
    return dict(_encoders_cached(_stat_key(ffmpeg or find_ffmpeg())))


@functools.lru_cache(maxsize=64)
def _encoder_pix_fmts_cached(key: tuple[str, int, int], name: str) -> tuple[str, ...]:
    result = run_tool(
        [key[0], "-hide_banner", "-nostdin", "-h", f"encoder={name}"], timeout=15.0, max_stdout_bytes=1 << 20
    )
    for raw in result.stdout.decode("utf-8", errors="replace").splitlines():
        line = raw.strip()
        if line.lower().startswith("supported pixel formats:"):
            return tuple(line.split(":", 1)[1].split())
    return ()


def encoder_pixel_formats(name: str, ffmpeg: str | None = None) -> tuple[str, ...]:
    """Pixel formats an encoder accepts according to ``ffmpeg -h encoder=<name>``."""
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", name):
        raise MediaError("INVALID_ARGUMENT", f"encoder 名稱不合法：{name}")
    return _encoder_pix_fmts_cached(_stat_key(ffmpeg or find_ffmpeg()), name)


@functools.lru_cache(maxsize=16)
def _graph_script_option_cached(key: tuple[str, int, int]) -> str:
    result = run_tool([key[0], "-hide_banner", "-nostdin", "-h", "full"], timeout=15.0, max_stdout_bytes=16 << 20)
    text = result.stdout.decode("utf-8", errors="replace")
    if result.returncode != 0 or "-filter_complex" not in text:
        raise MediaError("MEDIA_TOOL_FAILED", "無法讀取 FFmpeg 的選項說明")
    # Newer builds read any option from a file (``-/option file``) and deprecate the dedicated script option.
    return (
        "-/filter_complex"
        if "-/filter_complex" in text or "-filter_complex_script" not in text
        else "-filter_complex_script"
    )


def graph_script_args(path: str | os.PathLike[str], ffmpeg: str | None = None) -> list[str]:
    """Arguments that make this ffmpeg build read a complex filter graph from ``path`` (asked once per binary)."""
    return [_graph_script_option_cached(_stat_key(ffmpeg or find_ffmpeg())), os.fspath(path)]


def input_url(path: str | os.PathLike[str]) -> str:
    """``file:`` URL for an absolute local path (never interpreted as another protocol)."""
    return "file:" + os.path.abspath(os.fspath(path))


def is_within(path: Path, roots: Sequence[Path]) -> bool:
    real = os.path.realpath(path)
    for root in roots:
        base = os.path.realpath(root)
        if real == base or real.startswith(base.rstrip(os.sep) + os.sep):
            return True
    return False
