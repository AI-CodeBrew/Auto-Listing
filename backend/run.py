"""Start the backend locally:  python run.py

Uses the .venv Python by itself, so you do not need to activate the venv first.
Then open http://127.0.0.1:8000/api/status to check it is running. Ctrl + C stops it.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENV_PYTHON = HERE / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = os.environ.get("PORT", "8000")


def main() -> int:
    python = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable
    cmd = [python, "-m", "uvicorn", "app:app", "--host", HOST, "--port", PORT]
    print(f"Backend: http://{HOST}:{PORT}  (Ctrl + C to stop)")
    try:
        return subprocess.call(cmd, cwd=HERE)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
