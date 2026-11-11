"""Video frames (ffmpeg from imageio-ffmpeg) and direct video downloads."""
from __future__ import annotations

import os
import re
import shutil
import subprocess

from ..config import LIMITS, ai_limits
from ..storage import commit_file, remove_quietly, temp_path
from ..web.net import TooLargeError, download_to_file
from ..web.urls import video_extension


def ffmpeg() -> str:
    """FFMPEG_PATH, then imageio-ffmpeg, then the frontend's ffmpeg-static copy, then ffmpeg on PATH."""
    configured = (os.environ.get("FFMPEG_PATH") or "").strip()
    if configured and os.path.isfile(configured):
        return configured
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - try the other copies
        pass
    root = os.path.abspath(os.environ.get("APP_ROOT") or os.getcwd())
    for name in ("ffmpeg.exe", "ffmpeg"):
        bundled = os.path.join(root, "frontend", "node_modules", "ffmpeg-static", name)
        if os.path.isfile(bundled):
            return bundled
    found = shutil.which("ffmpeg")
    if found:
        return found
    raise RuntimeError("The ffmpeg binary is missing. Run: .venv\\Scripts\\python -m pip install imageio-ffmpeg")


def _run(args: list[str], timeout_s: float) -> tuple[bytes, str, bool]:
    try:
        done = subprocess.run([ffmpeg(), *args], capture_output=True, timeout=timeout_s, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return done.stdout, done.stderr.decode("utf-8", "replace"), done.returncode != 0
    except subprocess.TimeoutExpired as error:
        return error.stdout or b"", (error.stderr or b"").decode("utf-8", "replace"), True


def duration_seconds(file: str) -> float | None:
    _, stderr, _ = _run(["-hide_banner", "-i", file], 30)
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", stderr)
    return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3)) if match else None


def extract_frames(file: str, count: int | None = None) -> list[bytes]:
    """A few evenly spaced JPEG frames. Empty if none decode."""
    count = count or ai_limits()["framesPerVideo"]
    duration = duration_seconds(file)
    times = [(duration * (i + 1)) / (count + 1) for i in range(count)] if duration else list(range(count))
    frames = []
    for moment in times:
        stdout, _, failed = _run([
            "-hide_banner", "-loglevel", "error",
            "-ss", f"{moment:.2f}",
            "-i", file,
            "-frames:v", "1",
            "-vf", "scale='min(1280,iw)':-2",
            "-q:v", "3",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "pipe:1",
        ], 60)
        if not failed and stdout:
            frames.append(stdout)
    return frames


def download_video(product_id: str, url: str) -> dict:
    tmp = temp_path(product_id, "videos")
    try:
        result = download_to_file(url, tmp, LIMITS.video_max_bytes, 30 * 60_000)
        ext = video_extension(result["contentType"], result["finalUrl"])
        if not ext:
            remove_quietly(tmp)
            return {"status": "failed", "reason": f'Not a direct video file (server sent "{result["contentType"] or "no type"}")'}
        return {"status": "ok", "fileName": commit_file(product_id, "videos", tmp, ext), "bytes": result["bytes"]}
    except TooLargeError:
        remove_quietly(tmp)
        return {"status": "failed", "reason": "Video is larger than the 1 GB limit"}
    except Exception as error:  # noqa: BLE001
        remove_quietly(tmp)
        return {"status": "failed", "reason": f"Download failed: {error}"}
