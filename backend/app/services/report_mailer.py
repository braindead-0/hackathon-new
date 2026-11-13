"""Report email orchestration: recipient registry, automation toggle, weekly cron.

Recipients are captured at sign-in (email optional, falls back to
DEFAULT_REPORT_EMAIL). Generated PDFs are archived per owner in InsForge
Storage so the weekly job can re-send the latest report without a browser.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from datetime import datetime, timedelta
from html import escape
from threading import RLock
from typing import Any

from backend.app.services import email_report, insforge_storage
from backend.app.services.envconf import REPO_ROOT, load_env

log = logging.getLogger("digital_twin")

STATE_FILE = REPO_ROOT / "data" / "report_email_state.json"
WEEK = timedelta(days=7)
_state_lock = RLock()


def _load() -> dict[str, Any]:
    with _state_lock:
        if STATE_FILE.exists():
            try:
                return json.loads(STATE_FILE.read_text(encoding="utf-8"))
            except Exception:
                log.exception("could not read report email state; starting fresh")
        return {"recipients": {}, "automation": False, "last_sent": None}


def _save(state: dict[str, Any]) -> None:
    with _state_lock:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def owner_key(role: str | None, patient_id: str | None, clinician_id: str | None, name: str | None) -> str:
    if role == "patient" and patient_id:
        return f"patient:{patient_id}"
    if role == "doctor":
        return f"doctor:{clinician_id or name or 'unknown'}"
    return "guest"


def register_recipient(owner_id: str, role: str | None, name: str | None, email: str | None) -> str:
    effective = (email or "").strip() or email_report.default_email()
    with _state_lock:
        state = _load()
        state.setdefault("recipients", {})[owner_id] = {
            "role": role,
            "name": name,
            "email": effective,
        }
        _save(state)
    return effective


def normalize_phone(phone: str | None) -> str | None:
    raw = (phone or "").strip().removeprefix("whatsapp:")
    if not raw:
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not (8 <= len(digits) <= 15):
        raise ValueError("Enter a WhatsApp number in international format, e.g. +919876543210")
    return f"+{digits}"


MAX_EMERGENCY_CONTACTS = 6


def _clean_email(email: str | None) -> str | None:
    raw = (email or "").strip()
    if not raw:
        return None
    if "@" not in raw or len(raw) > 200:
        raise ValueError("Enter a valid email address, e.g. name@example.com")
    return raw


def _contact_field(raw: Any, key: str) -> Any:
    return raw.get(key) if isinstance(raw, dict) else getattr(raw, key, None)


def _clean_contact(raw: Any) -> dict[str, str] | None:
    name = str(_contact_field(raw, "name") or "").strip()[:80]
    relation = str(_contact_field(raw, "relation") or "").strip()[:40]
    if not name and not str(_contact_field(raw, "phone") or "").strip():
        return None
    phone = normalize_phone(_contact_field(raw, "phone"))
    if not phone:
        raise ValueError(f"Add a WhatsApp number for {name or 'the emergency contact'}")
    return {"name": name or "Emergency contact", "relation": relation, "phone": phone}


def _role_of(owner_id: str) -> str:
    return owner_id.split(":", 1)[0] if ":" in owner_id else "guest"


def _last_owner_with_phone(state: dict[str, Any], role: str) -> str | None:
    for owner, profile in reversed(list(state.get("alert_profiles", {}).items())):
        if _role_of(owner) == role and profile.get("phone"):
            return owner
    return None


def get_alert_profile(owner_id: str) -> dict[str, Any]:
    profile = _load().get("alert_profiles", {}).get(owner_id) or {}
    return {
        "name": profile.get("name"),
        "email": profile.get("email"),
        "phone": profile.get("phone"),
        "contacts": list(profile.get("contacts") or []),
    }


def set_alert_profile(
    owner_id: str,
    *,
    name: str | None = None,
    email: str | None = None,
    phone: str | None = None,
    contacts: list[Any] | None = None,
) -> dict[str, Any]:
    """Save a person's alert profile: their own number plus family/emergency contacts."""
    cleaned_phone = normalize_phone(phone)
    cleaned_email = _clean_email(email)
    cleaned_contacts: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in contacts or []:
        contact = _clean_contact(raw)
        if contact and contact["phone"] not in seen:
            seen.add(contact["phone"])
            cleaned_contacts.append(contact)
    if len(cleaned_contacts) > MAX_EMERGENCY_CONTACTS:
        raise ValueError(f"Keep at most {MAX_EMERGENCY_CONTACTS} emergency contacts")
    profile = {
        "name": (name or "").strip()[:120] or None,
        "email": cleaned_email,
        "phone": cleaned_phone,
        "contacts": cleaned_contacts,
    }
    with _state_lock:
        state = _load()
        profiles = state.setdefault("alert_profiles", {})
        if any(profile.values()):
            profiles[owner_id] = profile
        else:
            profiles.pop(owner_id, None)
        role = _role_of(owner_id)
        last = state.setdefault("alert_last", {})
        if cleaned_phone:
            last[role] = owner_id
        elif last.get(role) == owner_id:
            last[role] = _last_owner_with_phone(state, role)
        _save(state)
    return get_alert_profile(owner_id)


def set_alert_phone(owner_id: str, phone: str | None) -> str | None:
    """Update only the phone on an existing alert profile."""
    current = get_alert_profile(owner_id)
    return set_alert_profile(
        owner_id,
        name=current["name"],
        email=current["email"],
        phone=phone,
        contacts=current["contacts"],
    )["phone"]


def default_alert_phone() -> str | None:
    """CLINICIAN_ALERT_PHONE: the server-wide doctor number when none is saved."""
    try:
        return normalize_phone(load_env().get("CLINICIAN_ALERT_PHONE"))
    except ValueError:
        log.warning("CLINICIAN_ALERT_PHONE in .env is not a valid number; ignoring it")
        return None


def saved_alert_phone(owner_id: str) -> str | None:
    return get_alert_profile(owner_id)["phone"]


def alert_phone(owner_id: str | None = None) -> str | None:
    """A person's saved phone, else the last-active doctor's, else the server default."""
    state = _load()
    if owner_id is None:
        owner_id = (state.get("alert_last") or {}).get("doctor")
    if owner_id:
        profile = state.get("alert_profiles", {}).get(owner_id) or {}
        if profile.get("phone"):
            return profile["phone"]
    return default_alert_phone()


def alert_contacts_for_role(role: str) -> list[dict[str, str]]:
    """Emergency contacts of the last profile saved for a role (doctor/patient)."""
    owner = (_load().get("alert_last") or {}).get(role)
    return get_alert_profile(owner)["contacts"] if owner else []


def recipient_email(owner_id: str | None) -> str:
    state = _load()
    if owner_id:
        entry = state.get("recipients", {}).get(owner_id)
        if entry and entry.get("email"):
            return entry["email"]
    return email_report.default_email()


def get_automation() -> bool:
    return bool(_load().get("automation"))


def set_automation(enabled: bool) -> bool:
    with _state_lock:
        state = _load()
        state["automation"] = bool(enabled)
        _save(state)
    return bool(enabled)


def store_pdf(owner_id: str, title: str, pdf_bytes: bytes) -> str:
    stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    slug = "".join(ch if ch.isalnum() else "-" for ch in title.lower()).strip("-") or "report"
    key = f"pdfs/{owner_id}/{stamp}-{slug}.pdf"
    insforge_storage.upload_bytes(key, pdf_bytes, "application/pdf")
    return key


def latest_pdf(owner_id: str) -> tuple[str, str] | None:
    """Return (filename, base64) of the newest archived PDF for an owner."""
    prefix = f"pdfs/{owner_id}/"
    objs = insforge_storage.list_objects(prefix, insforge_storage.DEFAULT_BUCKET, 50, 0)
    if not objs:
        return None
    objs.sort(key=lambda o: o.get("uploadedAt") or "", reverse=True)
    key = objs[0].get("key", "")
    raw = insforge_storage.download_bytes(key)
    return key.rsplit("/", 1)[-1], base64.b64encode(raw).decode("ascii")


def build_email_html(title: str, subtitle: str, has_pdf: bool) -> str:
    title, subtitle = escape(title), escape(subtitle)
    attach = (
        "<p style='margin:12px 0 0;font-size:13px;color:#334155;'>The full report is attached as a PDF.</p>"
        if has_pdf
        else "<p style='margin:12px 0 0;font-size:13px;color:#334155;'>No PDF archived yet; generate a report to attach one.</p>"
    )
    return (
        "<div style='font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;'>"
        "<div style='background:#1a3fa0;color:#ffffff;padding:16px 20px;'>"
        "<div style='font-size:20px;font-weight:bold;'>VITALTWIN LAB</div>"
        "<div style='font-size:12px;'>VitalTwin Digital Health Centre &middot; Remote Post-Discharge Monitoring</div>"
        "</div>"
        "<div style='padding:20px;border:1px solid #e2e8f0;border-top:none;'>"
        f"<h2 style='margin:0 0 4px;font-size:18px;color:#18232c;'>{title}</h2>"
        f"<p style='margin:0 0 12px;font-size:13px;color:#64748b;'>{subtitle}</p>"
        "<p style='margin:0;font-size:13px;color:#334155;'>Your VitalTwin health report is ready.</p>"
        f"{attach}"
        "<p style='margin:16px 0 0;font-size:11px;color:#94a3b8;'>Clinical decision support, not medical diagnosis. Synthetic data only.</p>"
        "</div></div>"
    )


def send_weekly() -> list[dict[str, Any]]:
    state = _load()
    results: list[dict[str, Any]] = []
    for owner_id, entry in state.get("recipients", {}).items():
        to = entry.get("email") or email_report.default_email()
        pdf = None
        try:
            pdf = latest_pdf(owner_id)
        except Exception:
            log.exception("could not fetch archived PDF for %s", owner_id)
        filename, pdf_b64 = pdf if pdf else ("report.pdf", None)
        title = f"VitalTwin weekly report — {entry.get('name') or owner_id}"
        html = build_email_html(title, entry.get("role") or "monitoring", bool(pdf_b64))
        try:
            res = email_report.send_report_email(
                to=to, subject=title, html=html, pdf_base64=pdf_b64, pdf_filename=filename
            )
            results.append({"owner": owner_id, **res})
        except Exception as exc:
            log.exception("weekly report email failed for %s", owner_id)
            results.append({"owner": owner_id, "sent": False, "error": str(exc)})
    with _state_lock:
        latest = _load()
        latest["last_sent"] = datetime.utcnow().isoformat() + "Z"
        _save(latest)
    return results


def _due(state: dict[str, Any]) -> bool:
    last = state.get("last_sent")
    if not last:
        return True
    try:
        prev = datetime.fromisoformat(last.replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return True
    return datetime.utcnow() - prev >= WEEK


async def weekly_loop() -> None:
    """Background task: once automation is on, email reports every week."""
    while True:
        await asyncio.sleep(3600)
        try:
            state = _load()
            if state.get("automation") and _due(state):
                await asyncio.to_thread(send_weekly)
        except Exception:
            log.exception("weekly report email loop error")