"""InsForge AI gateway (OpenRouter) chat completions, server-side only.

The OpenRouter key lives in the repo-root .env (OPENROUTER_API_KEY), provisioned
by InsForge (`npx @insforge/cli ai setup`) or supplied manually. Server-only.
"""

from __future__ import annotations

import httpx

from backend.app.services.envconf import get as env_get

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "openai/gpt-4o-mini"


def _openrouter_key() -> str:
    return env_get("OPENROUTER_API_KEY")


def available() -> bool:
    return bool(_openrouter_key())


def chat(system_prompt: str, question: str) -> str:
    key = _openrouter_key()
    if not key:
        raise RuntimeError(
            "InsForge AI key missing. Run `npx @insforge/cli ai setup` (paid plan) "
            "or set OPENROUTER_API_KEY in .env."
        )
    model = env_get("OPENROUTER_CHAT_MODEL") or DEFAULT_MODEL
    url = env_get("OPENROUTER_BASE_URL") or OPENROUTER_URL
    with httpx.Client(timeout=60, trust_env=False) as client:
        resp = client.post(
            url,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": question},
                ],
                "max_tokens": 1024,
            },
        )
    resp.raise_for_status()
    data = resp.json()
    return (data["choices"][0]["message"]["content"] or "").strip()