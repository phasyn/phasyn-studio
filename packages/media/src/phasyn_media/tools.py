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

import contextlib
import functools
import io
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
from types import TracebackType
from typing import IO, Any, TypedDict, cast

from phasyn_components.runtime_env import ENV_FFMPEG, ENV_FFPROBE

from ._paths import absolute
from .errors import MediaCanceled, MediaError, cancel_requested


# environment variables forwarded to FFmpeg children (everything else is dropped)
_ENV_PASSTHROUGH = ("PATH", "LD_LIBRARY_PATH", "TMPDIR", "SYSTEMROOT")
_ENV_PREFIX_PASSTHROUGH = ("CUDA_", "NVIDIA_", "__NV_")
_POLL_INTERVAL = 0.02


# --------------------------------------------------------------------------- discovery


def _validate_executable(candidate: str, env_name: str) -> str:
    path = str(absolute(candidate))
    if not Path(path).is_file() or not os.access(path, os.X_OK):
        # The base name only: an error that reaches a run never carries a local path
        raise MediaError(
            "MEDIA_TOOL_FAILED",
            f"{Path(path).name} 不是可執行檔（來源：{env_name} 或 PATH）",
        )
    return path


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def _expand_executable(raw: str) -> str:
    try:
        expanded = Path(raw).expanduser()
    except RuntimeError:
        return raw
    return str(expanded)


def _resolve_tool(
    env_name: str, default_name: str, sibling_of: str | None = None
) -> str:
    raw = _env(env_name)
    if raw:
        if "://" in raw:
            raise MediaError("INVALID_ARGUMENT", f"{env_name} 必須是本機路徑")
        if os.sep not in raw:
            found = shutil.which(raw)
            if found is None:
                raise MediaError(
                    "MEDIA_TOOL_FAILED", f"找不到 {env_name} 指定的工具：{raw}"
                )
            return _validate_executable(found, env_name)
        return _validate_executable(_expand_executable(raw), env_name)
    found = shutil.which(default_name)
    if found is None and sibling_of is not None:
        sibling = str(Path(sibling_of).parent / default_name)
        if Path(sibling).is_file():
            found = sibling
    if found is None:
        raise MediaError(
            "MEDIA_TOOL_FAILED",
            f"找不到 {default_name}；請安裝 FFmpeg 或設定 {env_name}",
        )
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
    """Build the child environment for FFmpeg tools."""
    env = {
        k: v
        for k, v in os.environ.items()
        if k in _ENV_PASSTHROUGH or k.startswith(_ENV_PREFIX_PASSTHROUGH)
    }
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
        """Set the maximum size of the captured output tail."""
        self._limit = max(1024, int(limit))
        self._head_limit = min(16 * 1024, self._limit // 4)
        self._head = bytearray()
        self._buf = bytearray()
        self._dropped = 0
        self._lock = threading.Lock()

    def feed(self, chunk: bytes) -> None:
        """Retain the newest bytes within the capture limit."""
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
        """Decode the captured tail for diagnostics."""
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


class _MediaChild(subprocess.Popen[bytes]):
    """Start an argument vector in an isolated process group with an explicit environment."""

    @staticmethod
    def arguments(argv: Sequence[str]) -> tuple[str, ...]:
        if isinstance(argv, (str, bytes)) or not all(isinstance(a, str) for a in argv):
            raise MediaError("INVALID_ARGUMENT", "子程序參數必須是字串清單")
        return tuple(argv)

    def __init__(
        self,
        argv: tuple[str, ...],
        *,
        stdin: int | IO[Any] | None,
        stdout: int | IO[Any] | None,
        env: Mapping[str, str] | None,
    ) -> None:
        """Open the supervised pipes without a shell or inherited descriptors."""
        super().__init__(
            list(argv),
            stdin=stdin,
            stdout=stdout,
            stderr=subprocess.PIPE,
            start_new_session=True,
            close_fds=True,
            env=dict(env) if env is not None else tool_env(),
            shell=False,
        )


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
        """Start the supervised tool with bounded diagnostic capture."""
        self.argv = _MediaChild.arguments(argv)
        self._lock = threading.Lock()
        self._stderr = BoundedTail(max_stderr_bytes)
        try:
            self._proc = _MediaChild(self.argv, stdin=stdin, stdout=stdout, env=env)
        except OSError as exc:
            raise MediaError(
                "MEDIA_TOOL_FAILED",
                f"無法啟動 {Path(self.argv[0]).name}：{exc.strerror}",
            ) from exc
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr, name="media-stderr", daemon=True
        )
        self._stderr_thread.start()

    @property
    def pid(self) -> int:
        """Return the operating system process identifier."""
        return self._proc.pid

    @property
    def stdin(self) -> IO[bytes] | None:
        """Return the pipe feeding the child process."""
        return self._proc.stdin

    @property
    def stdout(self) -> io.BufferedReader[io.FileIO] | None:
        """Return the default buffered binary pipe when the child has piped output."""
        return cast("io.BufferedReader[io.FileIO] | None", self._proc.stdout)

    @property
    def returncode(self) -> int | None:
        """Return the exit code, or None while the child is running."""
        return self._proc.returncode

    def _drain_stderr(self) -> None:
        stream = self._proc.stderr
        if stream is None:
            return
        try:
            while True:
                chunk = (
                    stream.read1(65536)
                    if hasattr(stream, "read1")
                    else stream.read(65536)
                )
                if not chunk:
                    break
                self._stderr.feed(chunk)
        except (OSError, ValueError):
            pass

    def poll(self) -> int | None:
        """Check whether the child has exited."""
        with self._lock:
            return self._proc.poll()

    def wait(self, timeout: float | None) -> int | None:
        """Wait for the child and return its exit status."""
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
                    with contextlib.suppress(ProcessLookupError):
                        self._proc.kill()
        return self.wait(wait_seconds)

    def stderr_text(self) -> str:
        """Return the bounded diagnostic output from the child."""
        return self._stderr.text()

    def close(self, *, join_seconds: float = 2.0) -> None:
        """Release the child process and its associated pipes."""
        for stream in (self._proc.stdin, self._proc.stdout):
            if stream is not None:
                with contextlib.suppress(OSError, ValueError):
                    stream.close()
        self._stderr_thread.join(join_seconds)
        if self._proc.stderr is not None:
            with contextlib.suppress(OSError, ValueError):
                self._proc.stderr.close()


@dataclass
class _DrainState:
    bytes: int = 0
    overflow: bool = False
    sink_error: Exception | None = None

    def __enter__(self) -> None:
        """Observe an individual call to the stdout consumer."""

    def __exit__(
        self,
        _type: type[BaseException] | None,
        exc: BaseException | None,
        _traceback: TracebackType | None,
    ) -> bool:
        """Save callback failures for the supervisor so it can stop the child before reporting."""
        if isinstance(exc, Exception):
            self.sink_error = exc
            return True
        return False


@dataclass(frozen=True)
class ToolResult:
    """The exit status and captured output of a media tool."""

    argv: tuple[str, ...]
    returncode: int
    stdout: bytes
    stdout_bytes: int
    stderr: str
    elapsed_seconds: float


def run_tool(  # noqa: PLR0913 - Preserve the public keyword signature.
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
        writer = threading.Thread(
            target=_feed_stdin, args=(proc, stdin_data), name="media-stdin", daemon=True
        )
        writer.start()
    collected = bytearray()
    state = _DrainState()
    options: _ToolOptions = {
        "stdout_sink": stdout_sink,
        "max_stdout_bytes": max_stdout_bytes,
        "cancel": cancel,
        "what": what,
    }

    reader = threading.Thread(
        target=_drain_stdout,
        args=(proc, collected, state, options),
        name="media-stdout",
        daemon=True,
    )
    if stdout_fd is None:
        reader.start()
    try:
        _wait_for_tool(proc, state, started, timeout, options)
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
        raise MediaError(
            "RESOURCE_EXHAUSTED", f"{what} 輸出超過 {max_stdout_bytes} bytes 上限"
        )
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
    st = Path(path).stat()
    return (os.path.realpath(path), st.st_mtime_ns, st.st_size)


@dataclass(frozen=True)
class EncoderInfo:
    """The encoder name and evidence of its availability."""

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
    result = run_tool(
        [key[0], "-hide_banner", "-nostdin", "-encoders"],
        timeout=15.0,
        max_stdout_bytes=4 << 20,
    )
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
        [key[0], "-hide_banner", "-nostdin", "-h", f"encoder={name}"],
        timeout=15.0,
        max_stdout_bytes=1 << 20,
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
    result = run_tool(
        [key[0], "-hide_banner", "-nostdin", "-h", "full"],
        timeout=15.0,
        max_stdout_bytes=16 << 20,
    )
    text = result.stdout.decode("utf-8", errors="replace")
    if result.returncode != 0 or "-filter_complex" not in text:
        raise MediaError("MEDIA_TOOL_FAILED", "無法讀取 FFmpeg 的選項說明")
    # Newer builds read any option from a file (``-/option file``) and deprecate the dedicated script option.
    return (
        "-/filter_complex"
        if "-/filter_complex" in text or "-filter_complex_script" not in text
        else "-filter_complex_script"
    )


def graph_script_args(
    path: str | os.PathLike[str], ffmpeg: str | None = None
) -> list[str]:
    """Arguments that make this ffmpeg build read a complex filter graph from ``path`` (asked once per binary)."""
    return [
        _graph_script_option_cached(_stat_key(ffmpeg or find_ffmpeg())),
        os.fspath(path),
    ]


def input_url(path: str | os.PathLike[str]) -> str:
    """``file:`` URL for an absolute local path (never interpreted as another protocol)."""
    return "file:" + str(absolute(path))


def is_within(path: Path, roots: Sequence[Path]) -> bool:
    """Check whether the path resolves beneath the allowed directory."""
    real = os.path.realpath(path)
    for root in roots:
        base = os.path.realpath(root)
        if real == base or real.startswith(base.rstrip(os.sep) + os.sep):
            return True
    return False


def _feed_stdin(proc: ManagedProcess, stdin_data: bytes) -> None:
    stream = proc.stdin
    if stream is None:
        return
    try:
        stream.write(stdin_data)
        stream.flush()
    except (OSError, ValueError):
        pass
    finally:
        with contextlib.suppress(OSError, ValueError):
            stream.close()


class _ToolOptions(TypedDict):
    stdout_sink: Callable[[bytes], None] | None
    max_stdout_bytes: int
    cancel: Any
    what: str


def _drain_stdout(
    proc: ManagedProcess,
    collected: bytearray,
    state: _DrainState,
    options: _ToolOptions,
) -> None:
    stdout_sink = options.get("stdout_sink")
    max_stdout_bytes = options.get("max_stdout_bytes", 16 * 1024 * 1024)
    stream = proc.stdout
    if stream is None:
        return
    try:
        while True:
            chunk = (
                stream.read1(1 << 20)
                if hasattr(stream, "read1")
                else stream.read(1 << 20)
            )
            if not chunk:
                break
            state.bytes += len(chunk)
            if stdout_sink is not None:
                with state:
                    stdout_sink(chunk)
                if state.sink_error is not None:
                    break
            elif len(collected) + len(chunk) > max_stdout_bytes:
                state.overflow = True
                break
            else:
                collected.extend(chunk)
    except (OSError, ValueError):
        pass


def _wait_for_tool(
    proc: ManagedProcess,
    state: _DrainState,
    started: float,
    timeout: float,
    options: _ToolOptions,
) -> None:
    what = options.get("what", "FFmpeg")
    cancel = options.get("cancel")
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
            raise MediaError(
                "MEDIA_TOOL_FAILED", f"{what} 執行逾時（{timeout:.0f} 秒）"
            )
        time.sleep(_POLL_INTERVAL)
