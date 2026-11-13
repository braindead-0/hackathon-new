"""Single source of truth for API credentials and endpoint URLs: repo-root ``.env``.

Every external integration (Twilio WhatsApp, Telegram, Groq, OpenRouter /
InsForge AI, InsForge Storage, HAPI FHIR) reads its keys and base URLs from
``.env``. Real process environment variables override the file. No secret is
hardcoded in source or committed (``.env`` is gitignored).
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values

REPO_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = REPO_ROOT / ".env"


def load_env() -> dict[str, str]:
    cfg: dict[str, str] = {}
    if ENV_FILE.exists():
        for key, value in dotenv_values(ENV_FILE).items():
            if value is not None:
                cfg[key] = value.strip()
    for key, value in os.environ.items():
        if value:
            cfg[key] = value.strip()
    return cfg


def get(key: str, default: str = "") -> str:
    return load_env().get(key, default) or default