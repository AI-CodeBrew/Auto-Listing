"""Loads .env files without overwriting variables that are already set (tests set their own)."""
from __future__ import annotations

import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.dirname(HERE)


def _parse(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    with open(path, encoding="utf-8-sig") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[7:]
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            elif " #" in value:
                value = value.split(" #", 1)[0].rstrip()
            values[key] = value
    return values


def load_env_files() -> None:
    """Reads backend/.env, where every key lives. The project folder (APP_ROOT) is the folder above backend/."""
    os.environ.setdefault("APP_ROOT", PROJECT)
    if os.environ.get("PLA_SKIP_ENV_FILES") == "1":
        return
    path = os.path.join(HERE, ".env")
    if os.path.isfile(path):
        for key, value in _parse(path).items():
            os.environ.setdefault(key, value)
