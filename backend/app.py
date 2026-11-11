"""FastAPI backend for the Product Listing Assistant.

Serves every /api route the Next.js frontend calls, plus accounts, billing and the admin portal.
Run:  .venv\\Scripts\\python -m uvicorn app:app --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from pla.envfile import load_env_files  # noqa: E402

load_env_files()

from pla.api import create_app  # noqa: E402

app = create_app()
