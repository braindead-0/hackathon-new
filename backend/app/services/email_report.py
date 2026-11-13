"""Resend email delivery for health reports (server-side only).

The API key lives in the gitignored repo-root ``.env`` (RESEND_API_KEY) and is
never exposed to the frontend. Calls go to the official Resend REST endpoint.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from backend.app.services.envconf import get as env_get

log = logging.getLogger("digital_twin")

RESEND_URL = "https://api.resend.com/emails"


def _key() -> str:
    return env_get("RESEND_API_KEY")


def available() -> bool:
    return bool(_key())


def default_email() -> str:
    return env_get("DEFAULT_REPORT_EMAIL", "shreeharshastark@gmail.com")


def sender() -> str:
    return env_get("RESEND_FROM", "onboarding@resend.dev")


def send_report_email(
    *,
    to: str,
    subject: str,
    html: str,
    pdf_base64: str | None = None,
    pdf_filename: str = "report.pdf",
) -> dict[str, Any]:
    key = _key()
    if not key:
        raise RuntimeError("RESEND_API_KEY missing. Add it to the repo-root .env.")
    payload: dict[str, Any] = {
        "from": sender(),
        "to": [to],
        "subject": subject,
        "html": html,
    }
    if pdf_base64:
        payload["attachments"] = [{"filename": pdf_filename, "content": pdf_base64}]
    with httpx.Client(timeout=60, trust_env=False) as client:
        resp = client.post(
            RESEND_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload,
        )
    if not resp.is_success:
        try:
            detail = resp.json().get("message") or "Email provider rejected the request"
        except ValueError:
            detail = "Email provider rejected the request"
        raise RuntimeError(f"Resend ({resp.status_code}): {detail}")
    data = resp.json()
    return {"sent": True, "id": data.get("id"), "to": to}