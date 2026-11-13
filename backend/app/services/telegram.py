"""Telegram notification channel (official Bot API), sharing the WhatsApp format."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from backend.app.services.envconf import get as env_get
from backend.app.services.whatsapp import _load_config, format_alert, format_report

log = logging.getLogger("ps03.telegram")

API_BASE = env_get("TELEGRAM_API_BASE", "https://api.telegram.org")


def _send_telegram(text: str) -> dict[str, Any]:
    cfg = _load_config()
    token = cfg.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = cfg.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        return {"sent": False, "error": "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in .env."}
    if cfg.get("DRY_RUN", "false").lower() in ("1", "true", "yes"):
        log.info("Telegram DRY_RUN message to %s: %s", chat_id, text[:200])
        return {"sent": True, "dry_run": True, "chat_id": chat_id}
    try:
        with httpx.Client(timeout=30, trust_env=False) as client:
            response = client.post(
                f"{API_BASE}/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": text[:4000], "disable_web_page_preview": True},
            )
            payload = response.json()
        if payload.get("ok"):
            return {"sent": True, "message_id": (payload.get("result") or {}).get("message_id")}
        return {"sent": False, "error": payload.get("description", "Telegram send failed")}
    except Exception as exc:
        log.warning("Telegram send failed: %s", exc)
        return {"sent": False, "error": str(exc)}


def send_telegram_text(text: str) -> dict[str, Any]:
    """Send pre-composed text to the configured clinician chat."""
    return _send_telegram(text)


def send_telegram_alert(
    *,
    patient_name: str,
    patient_id: str,
    tier: str,
    news2_total: int | None,
    vitals: dict[str, float | None],
    narrative: str,
    abnormal: list[str] | None = None,
    risk_level: str | None = None,
    audience: str = "clinician",
) -> dict[str, Any]:
    return _send_telegram(
        format_alert(
            patient_name=patient_name,
            patient_id=patient_id,
            tier=tier,
            news2_total=news2_total,
            vitals=vitals,
            narrative=narrative,
            abnormal=abnormal,
            risk_level=risk_level,
            audience=audience,
        )
    )


def send_telegram_report(*, title: str, summary_text: str) -> dict[str, Any]:
    return _send_telegram(format_report(title=title, summary_text=summary_text))