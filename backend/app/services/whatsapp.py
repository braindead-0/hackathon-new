from __future__ import annotations

import logging
from typing import Any

from backend.app.services.envconf import load_env

log = logging.getLogger("ps03.whatsapp")


def _load_config() -> dict[str, str]:
    return load_env()


def _normalize_whatsapp(number: str) -> str:
    raw = number.strip()
    if raw.startswith("whatsapp:"):
        return raw
    if not raw.startswith("+"):
        raw = f"+{raw}"
    return f"whatsapp:{raw}"


def _send_twilio_message(body: str, recipient_override: str | None = None) -> dict[str, Any]:
    """Send a WhatsApp message via Twilio using .env credentials."""
    cfg = _load_config()
    sender = cfg.get("TWILIO_WHATSAPP_FROM", "")
    sid = cfg.get("TWILIO_ACCOUNT_SID", "")
    auth_token = cfg.get("TWILIO_AUTH_TOKEN", "")
    api_key = cfg.get("TWILIO_API_KEY", "")
    api_secret = cfg.get("TWILIO_API_SECRET", "")
    dry_run = cfg.get("DRY_RUN", "false").lower() in ("1", "true", "yes")

    raw_recipients = (
        recipient_override.strip()
        if recipient_override and recipient_override.strip()
        else cfg.get("ALERT_RECIPIENTS", "")
    )
    recipients = [
        _normalize_whatsapp(r)
        for r in raw_recipients.split(",")
        if r.strip()
    ]

    if not recipients:
        return {"sent": False, "error": "No ALERT_RECIPIENTS configured."}
    if not sender or not sid or (not auth_token and not (api_key and api_secret)):
        return {"sent": False, "error": "Twilio WhatsApp credentials missing in .env."}

    if dry_run:
        log.info("WhatsApp DRY_RUN message to %s: %s", recipients, body)
        return {"sent": True, "dry_run": True, "recipients": recipients, "sids": []}

    try:
        from twilio.rest import Client

        client = (
            Client(api_key, api_secret, sid)
            if (api_key and api_secret)
            else Client(sid, auth_token)
        )
        from_wa = _normalize_whatsapp(sender)
        sids: list[str] = []
        errors: list[str] = []
        for to_wa in recipients:
            try:
                msg = client.messages.create(from_=from_wa, to=to_wa, body=body[:1580])
                sids.append(msg.sid)
            except Exception as exc:
                # one unreachable number must not hide the successful sends
                errors.append(f"{to_wa}: {exc}")
        if not sids:
            return {"sent": False, "error": "; ".join(errors), "recipients": recipients}
        result = {"sent": True, "dry_run": False, "recipients": recipients, "sids": sids}
        if errors:
            result["errors"] = errors
        return result
    except Exception as exc:
        log.warning("WhatsApp send failed: %s", exc)
        return {"sent": False, "error": str(exc), "recipients": recipients}


_TIER_ACTION = {
    "URGENT": "Please seek emergency medical attention immediately or contact your clinical care team. Do not delay.",
    "REVIEW": "Please contact your clinical care team today for a review. Do not wait for your next scheduled visit.",
    "WATCH": "Keep a close eye on how you feel and re-check your vitals soon. Contact your team if anything worsens.",
    "NORMAL": "No action needed right now. Continue your routine monitoring.",
}

_CLINICIAN_ACTION = {
    "URGENT": "Review immediately and escalate per local protocol.",
    "REVIEW": "Review today and decide on escalation.",
    "WATCH": "Review when convenient; no immediate action needed.",
    "NORMAL": "No action needed; routine monitoring continues.",
}

_ALERT_HEADING = {
    "patient": {
        "URGENT": "⚠️ VITALTWIN | URGENT HEALTH ALERT",
        "REVIEW": "🔔 VITALTWIN | REVIEW NEEDED",
        "WATCH": "👀 VITALTWIN | WATCH — KEEP MONITORING",
        "NORMAL": "✅ VITALTWIN | READINGS STEADY",
    },
    "clinician": {
        "URGENT": "⚠️ VITALTWIN | URGENT CLINICAL ALERT",
        "REVIEW": "🔔 VITALTWIN | CLINICAL REVIEW NEEDED",
        "WATCH": "👀 VITALTWIN | CLINICAL WATCH",
        "NORMAL": "✅ VITALTWIN | CLINICAL READINGS STEADY",
    },
    "family": {
        "URGENT": "⚠️ VITALTWIN | URGENT EMERGENCY ALERT",
        "REVIEW": "🔔 VITALTWIN | HEALTH UPDATE",
        "WATCH": "👀 VITALTWIN | HEALTH UPDATE",
        "NORMAL": "✅ VITALTWIN | HEALTH UPDATE",
    },
}

_ALERT_LEAD = {
    "patient": {
        "URGENT": "Your latest health readings indicate a high clinical risk.",
        "REVIEW": "Your latest health readings need a clinical review.",
        "WATCH": "Your latest health readings are worth keeping an eye on.",
        "NORMAL": "Your latest health readings are within the expected range.",
    },
    "clinician": {
        "URGENT": "Latest readings indicate a high clinical risk.",
        "REVIEW": "Latest readings need clinical review.",
        "WATCH": "Latest readings are drifting; monitor closely.",
        "NORMAL": "Latest readings are within the expected range.",
    },
    "family": {
        "URGENT": "You are listed as an emergency contact. Their latest readings indicate a high clinical risk.",
        "REVIEW": "Their latest readings need a clinical review.",
        "WATCH": "Their latest readings are worth keeping an eye on.",
        "NORMAL": "Their latest readings are within the expected range.",
    },
}

_ACTION_TITLE = {
    "URGENT": "Immediate Action Required",
    "REVIEW": "Action Needed Today",
    "WATCH": "Keep Monitoring",
    "NORMAL": "No Action Needed",
}

_SCORE_ICON = {"URGENT": "🚨", "REVIEW": "🟠", "WATCH": "🟡", "NORMAL": "🟢"}

_VITAL_DISPLAY = {
    "respiratory_rate": ("Respiratory Rate", "breaths/min"),
    "heart_rate": ("Heart Rate", "bpm"),
    "spo2": ("SpO₂", "%"),
    "temperature": ("Temperature", "°C"),
}


def _num(value: float | None) -> str:
    if value is None:
        return "—"
    f = float(value)
    return str(int(f)) if f.is_integer() else f"{f:.1f}"


def _vital_qualifier(key: str, value: float) -> str:
    if key == "spo2":
        if value < 90:
            return " (Critically Low)"
        if value < 95:
            return " (Low)"
    elif key == "heart_rate":
        if value >= 130:
            return " (Critically High)"
        if value > 100:
            return " (High)"
        if value < 50:
            return " (Low)"
    elif key == "respiratory_rate":
        if value >= 25:
            return " (High)"
        if value > 20:
            return " (Elevated)"
        if value < 12:
            return " (Low)"
    elif key == "temperature":
        if value >= 39:
            return " (High Fever)"
        if value >= 38:
            return " (Fever)"
        if value < 36:
            return " (Low)"
    return ""


def _format_alert_message(
    *,
    audience: str,
    patient_name: str,
    patient_id: str,
    tier: str,
    news2_total: int | None,
    vitals: dict[str, float | None],
    narrative: str,
    risk_level: str | None,
    contact_name: str | None = None,
) -> str:
    patient = audience != "clinician"
    lines = [_ALERT_HEADING[audience][tier]]
    if audience == "family":
        lines.append(f"Hello {contact_name or 'there'},")
        lines.append(f"About: {patient_name}")
    elif patient:
        lines.append(f"Hello {(patient_name or 'there').split()[0]},")
    else:
        lines.append(f"Patient: {patient_name} ({patient_id})")
    lines.append(_ALERT_LEAD[audience][tier])

    readings = [
        f"• {label}: {_num(vitals[key])}{unit if unit == '%' else ' ' + unit}"
        f"{_vital_qualifier(key, float(vitals[key]))}"
        for key, (label, unit) in _VITAL_DISPLAY.items()
        if vitals.get(key) is not None
    ]
    if readings:
        lines += ["", "📊 Current Health Readings" if patient else "📊 Current Readings", *readings]
    if news2_total is not None:
        label = (risk_level or "").replace(" clinical", "").strip().upper()
        risk = f" — {label}" if label else ""
        lines += ["", f"{_SCORE_ICON[tier]} NEWS2 Score: {news2_total}{risk}"]
    if narrative and narrative.strip():
        lines += ["", f"📝 {narrative.strip()}"]

    action = _TIER_ACTION[tier] if patient else _CLINICIAN_ACTION[tier]
    lines += ["", _ACTION_TITLE[tier], action, ""]
    lines.append("— VitalTwin Clinical Care Team" if patient else "— VitalTwin Clinical Team")
    lines.append("Clinical decision support, not a medical diagnosis.")
    return "\n".join(lines)


def format_alert(
    *,
    patient_name: str,
    patient_id: str,
    tier: str,
    news2_total: int | None,
    vitals: dict[str, float | None],
    narrative: str,
    abnormal: list[str] | None = None,
    risk_level: str | None = None,
    audience: str = "patient",
    contact_name: str | None = None,
) -> str:
    """Emoji-structured urgent-alert copy for patients, clinicians and family contacts."""
    safe_audience = audience if audience in _ALERT_HEADING else "patient"
    return _format_alert_message(
        audience=safe_audience,
        patient_name=patient_name,
        patient_id=patient_id,
        tier=tier if tier in _ACTION_TITLE else "WATCH",
        news2_total=news2_total,
        vitals=vitals,
        narrative=narrative,
        risk_level=risk_level,
        contact_name=contact_name,
    )


_REPORT_LEADINS = {
    "How you are doing": "",
    "What needs attention": "A few things to keep an eye on:",
    "What to do next": "What we suggest:",
    "What is going well": "The good news:",
    "Get help now if you have": "Get help straight away if you notice:",
    "My conditions & medications": "Your conditions and medications:",
    "Recent check-in notices": "Recent check-ins:",
    "Your latest numbers": "Your latest numbers:",
    "Immediate concerns": "What needs attention now:",
    "Clinical context": "Background:",
    "Abnormal NEWS2 parameters": "Readings outside the usual range:",
    "Sustained baseline drift": "Changes from the usual baseline:",
    "Recent clinical alerts": "Recent alerts:",
    "Sensor / device log": "Device notes:",
    "Other systems within range": "Everything else looks within range:",
    "Clinician addendum": "Your clinician's notes:",
    "Ward Census Overview": "Ward overview:",
    "Patient Roster": "Patients:",
}

_TABLE_HEADER_FIRST = {"Vital sign", "Parameter", "Patient", "Timestamp (UTC)"}


def _strip_inline(s: str) -> str:
    return s.replace("**", "").replace("__", "").replace("`", "").strip()


def format_report(*, title: str, summary_text: str) -> str:
    """Turn the report markdown into a plain, human-sounding note."""
    intro = "Here's your health summary." if title.startswith("My ") else "Here's the clinical summary."
    out = ["Hello,", "", intro]
    for raw in summary_text.splitlines():
        s = raw.strip()
        if not s:
            continue
        if s.startswith("# "):
            continue
        if s.startswith("_") and s.endswith("_"):
            continue
        if s.startswith(">"):
            continue
        if s.startswith("- **Generated:") or s.startswith("- **Prepared"):
            continue
        if s.startswith("## "):
            t = s[3:].strip()
            lead = _REPORT_LEADINS.get(t)
            if lead is None:
                lead = _REPORT_LEADINS.get(t.split(" (")[0], t + ":")
            if lead:
                out += ["", lead]
            continue
        if s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|")]
            if all(set(c) <= set("-: ") for c in cells):
                continue
            if not cells or cells[0] in _TABLE_HEADER_FIRST or len(cells) > 3:
                continue
            line = f"{cells[0]}: {cells[1]}" if len(cells) >= 2 else cells[0]
            if len(cells) == 3 and cells[2]:
                line += f" ({cells[2]})"
            out.append(line)
            continue
        if s.startswith("- ") or s.startswith("* "):
            out.append(_strip_inline(s[2:]))
            continue
        out.append(_strip_inline(s))
    out += [
        "",
        "— Your VitalTwin care team",
        "(This summary supports your care team; it isn't a diagnosis.)",
    ]
    text = "\n".join(out)
    if len(text) > 3500:
        text = text[:3450].rstrip() + "\n…"
    return text


def send_whatsapp_alert(
    *,
    patient_name: str,
    patient_id: str,
    tier: str,
    news2_total: int | None,
    vitals: dict[str, float | None],
    narrative: str,
    recipient_override: str | None = None,
    abnormal: list[str] | None = None,
    risk_level: str | None = None,
    audience: str = "patient",
    contact_name: str | None = None,
) -> dict[str, Any]:
    """Send a WhatsApp alert via Twilio using .env credentials."""
    body = format_alert(
        patient_name=patient_name,
        patient_id=patient_id,
        tier=tier,
        news2_total=news2_total,
        vitals=vitals,
        narrative=narrative,
        abnormal=abnormal,
        risk_level=risk_level,
        audience=audience,
        contact_name=contact_name,
    )
    return send_whatsapp_text(body, recipient_override=recipient_override)


def send_whatsapp_text(body: str, recipient_override: str | None = None) -> dict[str, Any]:
    """Send pre-composed text to an explicit number, or ALERT_RECIPIENTS."""
    return _send_twilio_message(body, recipient_override=recipient_override)


def _plain_summary(text: str, limit: int = 900) -> str:
    """Convert report markdown into a short plain-text note for WhatsApp."""
    out: list[str] = []
    for raw in text.splitlines():
        s = raw.strip()
        if not s or s.startswith(("#", "|", ">", "_")):
            continue
        if s.startswith("- **Generated:") or s.startswith("- **Prepared"):
            continue
        s = _strip_inline(s)
        if s.startswith("- "):
            s = "• " + s[2:]
        out.append(s)
    plain = "\n".join(out)
    return plain[:limit].rstrip() + ("…" if len(plain) > limit else "")


def format_report_review(
    *,
    patient_name: str,
    patient_id: str,
    title: str,
    clinician: str,
    reviewed_at: str,
    notes: dict[str, str] | None = None,
    patient_summary: str | None = None,
    audience: str = "patient",
) -> str:
    """Message sent to both sides when a clinician revises a report."""
    notes = notes or {}
    assessment = (notes.get("assessment") or "").strip()
    plan = (notes.get("plan") or "").strip()
    follow_up = (notes.get("followUp") or "").strip()

    if audience == "clinician":
        lines = [f"REPORT REVIEWED · {title}", f"Patient: {patient_name} ({patient_id})"]
        lines.append(f"Reviewed by: {clinician} · {reviewed_at} UTC")
        for label, text in (("Assessment", assessment), ("Plan", plan), ("Follow-up", follow_up)):
            if text:
                lines += ["", f"{label}: {text}"]
        lines += ["", "The revised report is stored in the patient record."]
        return "\n".join(lines)

    first = (patient_name or "there").split()[0]
    lines = [
        f"Hi {first}, your VitalTwin care team has reviewed your report.",
        f"Report: {title}",
    ]
    if assessment:
        lines += ["", f"What we found: {assessment}"]
    if plan:
        lines += ["", f"What we suggest: {plan}"]
    if follow_up:
        lines += ["", f"Follow-up: {follow_up}"]
    if patient_summary and patient_summary.strip():
        cleaned = _plain_summary(patient_summary)
        if cleaned:
            lines += ["", cleaned]
    lines += [
        "",
        "Open your dashboard to read the full report. If anything feels worse, contact your care team straight away.",
        "",
        "— Your VitalTwin care team",
        "(Decision support, not a diagnosis.)",
    ]
    text = "\n".join(lines)
    return text[:1580]


def send_whatsapp_report_review(
    *,
    patient_name: str,
    patient_id: str,
    title: str,
    clinician: str,
    reviewed_at: str,
    notes: dict[str, str] | None = None,
    patient_summary: str | None = None,
    recipient_override: str | None = None,
    audience: str = "patient",
) -> dict[str, Any]:
    body = format_report_review(
        patient_name=patient_name,
        patient_id=patient_id,
        title=title,
        clinician=clinician,
        reviewed_at=reviewed_at,
        notes=notes,
        patient_summary=patient_summary,
        audience=audience,
    )
    return send_whatsapp_text(body, recipient_override=recipient_override)


def send_whatsapp_report(
    *,
    title: str,
    summary_text: str,
    recipient_override: str | None = None,
) -> dict[str, Any]:
    """Send a formatted clinical/health report summary via WhatsApp."""
    body = format_report(title=title, summary_text=summary_text)
    return _send_twilio_message(body, recipient_override=recipient_override)