"""phasyn_media.tools: tool discovery overrides, the bounded subprocess runner and its pure helpers."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest
from phasyn_media.errors import MediaError
from phasyn_media.tools import (
    BoundedTail,
    input_url,
    parse_encoders,
    redact,
    run_tool,
    summarize_stderr,
)


def _python(code: str) -> list[str]:
    return [sys.executable, "-I", "-c", code]


def test_timeout_kills_the_whole_process_group(tmp_path: Path) -> None:
    marker = tmp_path / "grandchild.pid"
    code = (
        "import subprocess, sys, time\n"
        f"child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"open({str(marker)!r}, 'w').write(str(child.pid))\n"
        "time.sleep(60)\n"
    )
    with pytest.raises(MediaError) as err:
        run_tool(_python(code), timeout=3.0, what="sleeper")
    assert err.value.code == "MEDIA_TOOL_FAILED"
    # The child is gone now, so waiting cannot help: a missing marker means the host was too slow to start it.
    assert marker.exists(), "the child was killed before it started its grandchild; the timeout was too short here"
    grandchild = int(marker.read_text())
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            os.kill(grandchild, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        pytest.fail("the grandchild survived the timeout")


def test_pure_helpers() -> None:
    assert input_url("/srv/in.mp4") == "file:/srv/in.mp4"
    assert redact("open /srv/a/in.mp4 failed", {"/srv/a/in.mp4": "<input>"}) == "open <input> failed"
    stderr = "frame=1\n[h264 @ 0x55d] Driver does not support the required nvenc API version\nConversion failed!\n"
    assert summarize_stderr(stderr).startswith("Driver does not support the required nvenc API version")
    listing = " V....D libx264  libx264 H.264 (codec h264)\n A....D aac  AAC (Advanced Audio Coding)\n"
    encoders = parse_encoders("Encoders:\n ------\n" + listing)
    assert (encoders["libx264"].codec, encoders["aac"].media) == ("h264", "audio")
    tail = BoundedTail(1024)
    tail.feed(b"HEAD" + b"x" * 10_000 + b"TAIL")
    text = tail.text()
    assert text.startswith("HEAD") and text.endswith("TAIL") and len(text) < 3000
