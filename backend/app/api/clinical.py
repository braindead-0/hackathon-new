"""Clinical monitoring and FHIR ingestion endpoints (PS-03 §3.1, §3.6)."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from datetime import datetime, timedelta
from html import escape
from typing import Any
from urllib.parse import parse_qs
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, WebSocket
from pydantic import BaseModel, Field, field_validator

from backend.app.api.deps import Container, get_container
from backend.app.services.clinical import WARD_CHANNEL
from backend.app.services.groq_qa import answer_clinical_doubt
from backend.app.services import insforge_storage
from backend.app.services import email_report, report_mailer
from backend.app.services.envconf import load_env
from backend.app.services.whatsapp import (
    format_report_review,
    send_whatsapp_alert,
    send_whatsapp_report,
    send_whatsapp_text,
)
from backend.app.services.telegram import (
    send_telegram_alert,
    send_telegram_report,
    send_telegram_text,
)
from backend.app.services.xgb_risk import compare_with_xgboost
from clinical.fhir import VITAL_CODINGS, build_reading_bundle, naive_utc
from clinical.hapi_client import HapiError
from digital_twin.types import Observation

router = APIRouter(tags=["clinical"])
log = logging.getLogger("ps03.whatsapp")

DISCLAIMER = "Clinical decision support, not medical diagnosis."
_whatsapp_jobs: dict[str, dict[str, Any]] = {}
# Last patient WhatsApp number seen, so report edits can reach the patient too.
_patient_contacts: dict[str, str] = {}
_active_session: dict[str, Any] = {
    "role": None,
    "display_name": None,
    "patient_id": None,
    "email": None,
    "owner_id": None,
}


def clinical(container: Container = Depends(get_container)):
    service = getattr(container, "clinical", None)
    if service is None:
        raise HTTPException(status_code=503, detail="clinical service not configured")
    return service


class ReadingIn(BaseModel):
    """A normalized reading from the simulator or BIDMC replay."""

    timestamp: str
    heart_rate: float = Field(ge=0, le=300)
    spo2: float | None = Field(default=None, ge=0, le=100)
    respiratory_rate: float | None = Field(default=None, ge=0, le=90)
    temperature: float | None = Field(default=None, ge=25, le=45)
    systolic_bp: float | None = Field(default=None, ge=40, le=300)
    diastolic_bp: float | None = Field(default=None, ge=20, le=200)
    activity_intensity: float = Field(default=0.0, ge=0, le=1)
    source: str = "simulator"
    send_whatsapp: bool = False
    whatsapp_to: str | None = None


@router.get("/api/clinical/patients")
def list_patients(service=Depends(clinical)) -> dict[str, Any]:
    return {"patients": service.list_patients(), "disclaimer": DISCLAIMER}


@router.get("/api/clinical/patients/{patient_id}/state")
def patient_state(patient_id: str, service=Depends(clinical)) -> dict[str, Any]:
    try:
        return service.patient_state_payload(patient_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/api/clinical/patients/{patient_id}/alerts")
def patient_alerts(
    patient_id: str,
    limit: int = Query(default=50, ge=1, le=500),
    service=Depends(clinical),
) -> dict[str, Any]:
    try:
        return {"alerts": service.alerts(patient_id, limit), "disclaimer": DISCLAIMER}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/api/clinical/patients/{patient_id}/readings")
def patient_readings(
    patient_id: str,
    limit: int = Query(default=300, ge=1, le=2000),
    service=Depends(clinical),
) -> dict[str, Any]:
    try:
        return {"readings": service.readings(patient_id, limit)}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/api/fhir/Observation")
async def ingest_observation(request: Request, service=Depends(clinical)) -> dict[str, Any]:
    """Accept a FHIR R4 Vital Signs Observation, store it in HAPI, then score."""
    body = await request.json()
    if body.get("resourceType") != "Observation":
        raise HTTPException(status_code=400, detail="resourceType must be Observation")
    try:
        return await service.ingest_fhir_observation(body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (ValueError, HapiError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/fhir/Bundle")
async def ingest_bundle(request: Request, service=Depends(clinical)) -> dict[str, Any]:
    """Accept a FHIR Bundle of Vital Signs Observations."""
    body = await request.json()
    if body.get("resourceType") != "Bundle":
        raise HTTPException(status_code=400, detail="resourceType must be Bundle")
    try:
        return await service.ingest_fhir_bundle(body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (ValueError, HapiError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/clinical/patients/{patient_id}/readings")
async def ingest_reading(
    patient_id: str, reading: ReadingIn, service=Depends(clinical),
    c: Container = Depends(get_container),
) -> dict[str, Any]:
    """Internal ingestion for the simulator and BIDMC replay.

    Each vital is stored as its own LOINC-coded FHIR Observation in HAPI.
    """
    try:
        ts = naive_utc(datetime.fromisoformat(reading.timestamp.replace("Z", "+00:00")))
        if reading.source == "smartwatch_demo":
            patient_state = service.patient(patient_id)
            if patient_state.last_processed is not None and (
                ts <= patient_state.last_processed
                or (ts - patient_state.last_processed).total_seconds() > 300
            ):
                ts = patient_state.last_processed + timedelta(seconds=60)
            obs = Observation(
                timestamp=ts,
                heart_rate=reading.heart_rate,
                spo2=reading.spo2,
                respiratory_rate=reading.respiratory_rate,
                temperature=reading.temperature,
                systolic_bp=reading.systolic_bp,
                diastolic_bp=reading.diastolic_bp,
                activity_intensity=reading.activity_intensity,
                source=reading.source,
            )
            # Score immediately so the live demo isn't blocked by HAPI H2 write contention,
            # and persist the FHIR bundle asynchronously in the background.
            bundle_obs = [
                entry["resource"] for entry in build_reading_bundle(patient_id, obs)["entry"]
            ]
            if bundle_obs:
                async def _store_bg() -> None:
                    try:
                        await service.hapi.store_bundle(bundle_obs)
                        patient_state.stored_observations += len(bundle_obs)
                    except Exception:
                        pass
                asyncio.create_task(_store_bg())
            result = service._score_timestamp(
                patient_state,
                obs.timestamp,
                {m: getattr(obs, m, None) for m in VITAL_CODINGS},
                obs=obs,
            )
        else:
            obs = Observation(
                timestamp=ts,
                heart_rate=reading.heart_rate,
                spo2=reading.spo2,
                respiratory_rate=reading.respiratory_rate,
                temperature=reading.temperature,
                systolic_bp=reading.systolic_bp,
                diastolic_bp=reading.diastolic_bp,
                activity_intensity=reading.activity_intensity,
                source=reading.source,
            )
            result = await service.ingest_reading(patient_id, obs)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (ValueError, HapiError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not result:
        return {"scored": False}
    payload = result.to_dict()
    patient_state = service.patient(patient_id)
    payload["xgboost"] = compare_with_xgboost(
        patient_state=patient_state,
        vitals={
            "heart_rate": reading.heart_rate,
            "spo2": reading.spo2,
            "respiratory_rate": reading.respiratory_rate,
            "temperature": reading.temperature,
            "systolic_bp": reading.systolic_bp,
            "activity_intensity": reading.activity_intensity,
        },
        rule_tier=result.tier.value,
        news2_total=result.news2.total if result.news2 else None,
        suppressed=result.suppressed,
    )
    reading_phone = (reading.whatsapp_to or "").strip()
    if reading_phone:
        _patient_contacts[patient_id] = reading_phone
    patient_phone = reading_phone or _patient_contacts.get(patient_id, "")
    clinical_alert = result.alert_kind.value == "CLINICAL" and not result.suppressed
    if (
        reading.send_whatsapp
        and clinical_alert
        and result.tier.value in ("WATCH", "REVIEW", "URGENT")
    ):
        profile = service.patient(patient_id).profile
        patient_owner = report_mailer.owner_key("patient", patient_id, None, profile.display_name)
        patient_phone = patient_phone or report_mailer.get_alert_profile(patient_owner)["phone"]
        job_id = uuid.uuid4().hex[:12]
        _whatsapp_jobs[job_id] = {"queued": True, "sent": False}
        vitals_snapshot = {
            "heart_rate": reading.heart_rate,
            "spo2": reading.spo2,
            "respiratory_rate": reading.respiratory_rate,
            "temperature": reading.temperature,
        }
        narrative_text = (
            result.explanation.narrative
            if result.explanation
            else "Abnormal reading detected."
        )
        tier_value = result.tier.value
        news2_total = result.news2.total if result.news2 else None
        risk_level = result.news2.risk_level if result.news2 else None
        abnormal_metrics = list(
            dict.fromkeys(
                [
                    r["metric"]
                    for r in (result.explanation.readings if result.explanation else [])
                    if r.get("news2_points", 0) > 0
                ]
                + [d.metric for d in result.drift]
            )
        )

        payload["mobile"] = c.mobile_alerts.publish(
            patient_id=patient_id, event_id=job_id, tier=tier_value,
            patient_name=profile.display_name, vitals=vitals_snapshot,
            text=narrative_text,
        )

        clinician_phone = report_mailer.alert_phone()

        async def _send_wa_bg() -> None:
            calls = [
                (
                    "whatsapp",
                    asyncio.to_thread(
                        send_whatsapp_alert,
                        patient_name=profile.display_name,
                        patient_id=patient_id,
                        tier=tier_value,
                        news2_total=news2_total,
                        vitals=vitals_snapshot,
                        narrative=narrative_text,
                        recipient_override=clinician_phone,
                        abnormal=abnormal_metrics,
                        risk_level=risk_level,
                        audience="clinician",
                    ),
                ),
                (
                    "telegram",
                    asyncio.to_thread(
                        send_telegram_alert,
                        patient_name=profile.display_name,
                        patient_id=patient_id,
                        tier=tier_value,
                        news2_total=news2_total,
                        vitals=vitals_snapshot,
                        narrative=narrative_text,
                        abnormal=abnormal_metrics,
                        risk_level=risk_level,
                        audience="clinician",
                    ),
                ),
            ]
            if patient_phone:
                calls.append(
                    (
                        "patient",
                        asyncio.to_thread(
                            send_whatsapp_alert,
                            patient_name=profile.display_name,
                            patient_id=patient_id,
                            tier=tier_value,
                            news2_total=news2_total,
                            vitals=vitals_snapshot,
                            narrative=narrative_text,
                            recipient_override=patient_phone,
                            abnormal=abnormal_metrics,
                            risk_level=risk_level,
                            audience="patient",
                        ),
                    )
                )
            if tier_value == "URGENT":
                contacts = [
                    *report_mailer.alert_contacts_for_role("doctor"),
                    *report_mailer.get_alert_profile(patient_owner)["contacts"],
                ]
                notified = {clinician_phone, patient_phone, ""}
                for contact in contacts:
                    phone = contact.get("phone")
                    if not phone or phone in notified:
                        continue
                    notified.add(phone)
                    calls.append(
                        (
                            f"contact:{phone}",
                            asyncio.to_thread(
                                send_whatsapp_alert,
                                patient_name=profile.display_name,
                                patient_id=patient_id,
                                tier=tier_value,
                                news2_total=news2_total,
                                vitals=vitals_snapshot,
                                narrative=narrative_text,
                                recipient_override=phone,
                                abnormal=abnormal_metrics,
                                risk_level=risk_level,
                                audience="family",
                                contact_name=contact.get("name"),
                            ),
                        )
                    )
            results = await asyncio.gather(*(c for _, c in calls), return_exceptions=True)
            delivered = {
                key: ({"sent": False, "error": str(item)} if isinstance(item, Exception) else item)
                for (key, _), item in zip(calls, results)
            }
            wa = delivered.get("whatsapp", {"sent": False, "error": "not attempted"})
            _whatsapp_jobs[job_id] = {
                "queued": False,
                **wa,
                "telegram": delivered.get("telegram"),
                "patient": delivered.get("patient"),
                "contacts": {
                    key.split(":", 1)[1]: value
                    for key, value in delivered.items()
                    if key.startswith("contact:")
                },
            }

        asyncio.create_task(_send_wa_bg())
        payload["whatsapp"] = {"queued": True, "job_id": job_id, "sent": False}
    return payload


@router.get("/api/clinical/whatsapp/{job_id}")
async def whatsapp_status(job_id: str) -> dict[str, Any]:
    return _whatsapp_jobs.get(job_id) or {"queued": False, "sent": False, "error": "Unknown job"}


class WhatsAppReportIn(BaseModel):
    title: str
    summary_text: str
    whatsapp_to: str | None = None


@router.post("/api/clinical/whatsapp/report")
async def send_report_via_whatsapp(body: WhatsAppReportIn) -> dict[str, Any]:
    job_id = uuid.uuid4().hex[:12]
    _whatsapp_jobs[job_id] = {"queued": True, "sent": False}

    async def _send_report_bg() -> None:
        try:
            clinician = await asyncio.to_thread(
                send_whatsapp_report,
                title=body.title,
                summary_text=body.summary_text,
            )
            tg = await asyncio.to_thread(
                send_telegram_report,
                title=body.title,
                summary_text=body.summary_text,
            )
            patient = None
            if body.whatsapp_to and body.whatsapp_to.strip():
                patient = await asyncio.to_thread(
                    send_whatsapp_report,
                    title=body.title,
                    summary_text=body.summary_text,
                    recipient_override=body.whatsapp_to,
                )
            _whatsapp_jobs[job_id] = {
                "queued": False,
                **clinician,
                "telegram": tg,
                "patient": patient,
            }
        except Exception as exc:
            _whatsapp_jobs[job_id] = {"queued": False, "sent": False, "error": str(exc)}

    asyncio.create_task(_send_report_bg())
    return {"queued": True, "job_id": job_id, "sent": False}


@router.get("/api/clinical/patients/{patient_id}/xgboost")
async def patient_xgboost_comparison(patient_id: str, service=Depends(clinical)) -> dict[str, Any]:
    try:
        ps = service.patient(patient_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    latest = ps.readings[-1] if getattr(ps, "readings", None) else None
    last_alert = ps.alerts[-1] if getattr(ps, "alerts", None) else None
    vitals = {
        "heart_rate": getattr(latest, "heart_rate", None),
        "spo2": getattr(latest, "spo2", None),
        "respiratory_rate": getattr(latest, "respiratory_rate", None),
        "temperature": getattr(latest, "temperature", None),
        "systolic_bp": getattr(latest, "systolic_bp", None),
        "activity_intensity": getattr(latest, "activity_intensity", 0.0),
    }
    news2_total = last_alert.news2.total if (last_alert and last_alert.news2) else None
    latest_res = ps.latest or last_alert
    return compare_with_xgboost(
        patient_state=ps,
        vitals=vitals,
        rule_tier=latest_res.tier.value if latest_res else "NORMAL",
        news2_total=news2_total,
        suppressed=bool(latest_res.suppressed) if latest_res else False,
    )


@router.get("/api/clinical/hapi/health")
async def hapi_health(service=Depends(clinical)) -> dict[str, Any]:
    healthy = await service.hapi.healthy()
    return {"healthy": healthy, "base_url": service.hapi.base_url}


@router.websocket("/ws/clinical/ward")
async def ward_socket(websocket: WebSocket) -> None:
    """Ward overview: one row per patient, pushed as readings are scored."""
    c: Container = websocket.app.state.container
    await websocket.accept()
    if c.clinical is None:
        await websocket.send_json({"type": "error", "detail": "clinical service not configured"})
        await websocket.close()
        return
    initial: list[dict[str, Any]] = [
        {"type": "ward_snapshot", "data": {"patients": c.clinical.list_patients()}},
        {"type": "replay", "data": c.replay.status() if c.replay else {}},
    ]
    await c.hub.serve(websocket, WARD_CHANNEL, initial)


@router.websocket("/ws/clinical/{patient_id}")
async def clinical_socket(websocket: WebSocket, patient_id: str) -> None:
    c: Container = websocket.app.state.container
    await websocket.accept()
    service = c.clinical
    if service is None or patient_id not in service.patients:
        await websocket.send_json({"type": "error", "detail": f"unknown patient {patient_id!r}"})
        await websocket.close()
        return
    initial = [
        {"type": "clinical", "data": service.patient_state_payload(patient_id)},
        {"type": "alerts", "data": {"alerts": service.alerts(patient_id, 50)}},
        {"type": "replay", "data": c.replay.status() if c.replay else {}},
    ]
    await c.hub.serve(websocket, patient_id, initial)


@router.get("/api/clinical/hapi/observations/{patient_id}")
async def hapi_observations(
    patient_id: str,
    loinc: str | None = Query(default=None),
    count: int = Query(default=20, ge=1, le=200),
    service=Depends(clinical),
) -> dict[str, Any]:
    """Proxy a HAPI search, to demonstrate stored FHIR validity."""
    try:
        bundle = await service.hapi.search_observations(patient_id, loinc=loinc, count=count)
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503,
            detail="HAPI FHIR is unavailable or timed out. Check the FHIR server and retry.",
        ) from exc
    except HapiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "total": bundle.get("total"),
        "entries": [e.get("resource") for e in bundle.get("entry", [])],
    }


class ActiveSessionIn(BaseModel):
    role: str | None = None
    display_name: str | None = None
    patient_id: str | None = None
    clinician_id: str | None = None
    email: str | None = Field(default=None, max_length=254)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str | None) -> str | None:
        value = value.strip() if value else None
        if value and not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", value):
            raise ValueError("Enter a valid email address or leave it blank")
        return value or None


@router.post("/api/clinical/session/active")
async def set_active_session(body: ActiveSessionIn) -> dict[str, Any]:
    _active_session["role"] = body.role
    _active_session["display_name"] = body.display_name
    _active_session["patient_id"] = body.patient_id
    owner = report_mailer.owner_key(
        body.role, body.patient_id, body.clinician_id, body.display_name
    )
    _active_session["owner_id"] = owner
    email = None
    if body.role:
        email = report_mailer.register_recipient(owner, body.role, body.display_name, body.email)
    _active_session["email"] = email
    return {"ok": True, **_active_session}


class WhatsAppAskIn(BaseModel):
    question: str = Field(..., min_length=1)
    send_to_whatsapp: bool = True
    whatsapp_to: str | None = None
    role: str | None = None
    display_name: str | None = None
    patient_id: str | None = None


@router.post("/api/clinical/whatsapp/ask")
async def ask_clinical_whatsapp(body: WhatsAppAskIn, service=Depends(clinical)) -> dict[str, Any]:
    session_ctx = {
        "role": body.role or _active_session.get("role"),
        "display_name": body.display_name or _active_session.get("display_name"),
        "patient_id": body.patient_id or _active_session.get("patient_id"),
    }
    qa = await asyncio.to_thread(
        answer_clinical_doubt,
        service=service,
        question=body.question,
        active_session=session_ctx,
    )
    if body.send_to_whatsapp and qa.get("answer"):
        job_id = uuid.uuid4().hex[:12]
        _whatsapp_jobs[job_id] = {"queued": True, "sent": False}
        title = f"VitalTwin Q&A for {qa['addressed_to']}"

        async def _send_qa_bg() -> None:
            try:
                wa = await asyncio.to_thread(
                    send_whatsapp_report,
                    title=title,
                    summary_text=qa["answer"],
                    recipient_override=body.whatsapp_to,
                )
                _whatsapp_jobs[job_id] = {"queued": False, **wa}
            except Exception as exc:
                _whatsapp_jobs[job_id] = {"queued": False, "sent": False, "error": str(exc)}

        asyncio.create_task(_send_qa_bg())
        qa["whatsapp"] = {"queued": True, "job_id": job_id, "sent": False}
    return qa


class ReportStoreIn(BaseModel):
    patient_id: str
    title: str = "Health Report"
    html: str
    content_type: str = "text/html"


@router.post("/api/clinical/reports/store")
async def store_report(body: ReportStoreIn) -> dict[str, Any]:
    stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    slug = "".join(ch if ch.isalnum() else "-" for ch in body.title.lower()).strip("-") or "report"
    key = f"{body.patient_id}/{stamp}-{slug}.html"
    try:
        result = await asyncio.to_thread(
            insforge_storage.upload_bytes,
            key,
            body.html.encode("utf-8"),
            body.content_type,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"InsForge storage upload failed: {exc}")
    return {"bucket": insforge_storage.DEFAULT_BUCKET, "key": key, "url": result.get("url")}


class RecordSaveIn(BaseModel):
    patient_id: str
    report: dict[str, Any]
    patient_summary: str | None = Field(default=None, max_length=8000)
    whatsapp_to: str | None = Field(default=None, max_length=40)
    clinician_id: str | None = Field(default=None, max_length=120)


async def _notify_report_review(service, body: RecordSaveIn, title: str) -> dict[str, Any]:
    """Tell both the patient and the clinical team that a report was revised."""
    notes = body.report.get("doctorNotes") or {}
    clinician = str(notes.get("editedBy") or "Attending clinician")
    reviewed_at = datetime.utcnow().strftime("%d %b %Y %H:%M")
    try:
        patient_name = service.patient(body.patient_id).profile.display_name
    except (KeyError, AttributeError):
        patient_name = "Patient"

    phone = (body.whatsapp_to or "").strip() or _patient_contacts.get(body.patient_id, "")
    clinician_owner = report_mailer.owner_key("doctor", None, body.clinician_id, clinician)
    clinician_phone = report_mailer.alert_phone(clinician_owner)
    clinician_text = format_report_review(
        patient_name=patient_name,
        patient_id=body.patient_id,
        title=title,
        clinician=clinician,
        reviewed_at=reviewed_at,
        notes=notes,
        audience="clinician",
    )
    calls = [
        ("clinician", asyncio.to_thread(send_whatsapp_text, clinician_text, clinician_phone)),
        ("telegram", asyncio.to_thread(send_telegram_text, clinician_text)),
    ]
    if phone:
        patient_text = format_report_review(
            patient_name=patient_name,
            patient_id=body.patient_id,
            title=title,
            clinician=clinician,
            reviewed_at=reviewed_at,
            notes=notes,
            patient_summary=body.patient_summary,
            audience="patient",
        )
        calls.append(("patient", asyncio.to_thread(send_whatsapp_text, patient_text, phone)))

    results = await asyncio.gather(*(c for _, c in calls), return_exceptions=True)
    delivered = {
        key: ({"sent": False, "error": str(item)} if isinstance(item, Exception) else item)
        for (key, _), item in zip(calls, results)
    }
    return {
        "patient": delivered.get("patient")
        or {"sent": False, "error": "No patient WhatsApp number on file."},
        "clinician": delivered.get("clinician"),
        "telegram": delivered.get("telegram"),
    }


@router.post("/api/clinical/reports/record")
async def save_record(body: RecordSaveIn, service=Depends(clinical)) -> dict[str, Any]:
    """Persist a full report (incl. clinician edits) and notify both recipients."""
    title = str(body.report.get("title") or "Health Report")
    stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    slug = "".join(ch if ch.isalnum() else "-" for ch in title.lower()).strip("-") or "report"
    key = f"records/{body.patient_id}/{stamp}-{slug}.json"
    data = json.dumps(body.report).encode("utf-8")
    try:
        await asyncio.to_thread(
            insforge_storage.upload_bytes, key, data, "application/json"
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"InsForge storage upload failed: {exc}")
    try:
        notified = await _notify_report_review(service, body, title)
    except Exception as exc:  # the record is saved; a channel failure must not fail the save
        notified = {"patient": {"sent": False, "error": str(exc)}, "clinician": None, "telegram": None}
    return {"bucket": insforge_storage.DEFAULT_BUCKET, "key": key, "notified": notified}


@router.get("/api/clinical/reports/records")
async def list_records(patient_id: str = Query(...)) -> dict[str, Any]:
    """List saved report records for a patient, newest first, with edit metadata."""
    prefix = f"records/{patient_id}/"
    try:
        objs = await asyncio.to_thread(
            insforge_storage.list_objects, prefix, insforge_storage.DEFAULT_BUCKET, 100, 0
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"InsForge storage list failed: {exc}")
    objs.sort(key=lambda o: o.get("uploadedAt") or "", reverse=True)

    async def summarize(o: dict[str, Any]) -> dict[str, Any]:
        key = o.get("key", "")
        rep: dict[str, Any] = {}
        try:
            raw = await asyncio.to_thread(insforge_storage.download_bytes, key)
            rep = json.loads(raw)
        except Exception:
            rep = {}
        notes = rep.get("doctorNotes") or {}
        modified = bool(notes.get("editedAt") or notes.get("assessment") or notes.get("plan") or notes.get("followUp"))
        return {
            "key": key,
            "title": rep.get("title") or "Health Report",
            "kind": rep.get("kind"),
            "generatedAt": rep.get("generatedAt"),
            "editedAt": notes.get("editedAt"),
            "editedBy": notes.get("editedBy"),
            "modified": modified,
            "size": o.get("size"),
            "uploadedAt": o.get("uploadedAt"),
        }

    records = await asyncio.gather(*(summarize(o) for o in objs[:20]))
    return {"records": records}


@router.get("/api/clinical/reports/record")
async def get_record(key: str = Query(...)) -> dict[str, Any]:
    """Fetch one saved report record by its storage key."""
    if not key.startswith("records/"):
        raise HTTPException(status_code=400, detail="invalid record key")
    try:
        raw = await asyncio.to_thread(insforge_storage.download_bytes, key)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"InsForge storage download failed: {exc}")
    try:
        return json.loads(raw)
    except Exception:
        raise HTTPException(status_code=502, detail="stored record is not valid JSON")


class ReportEmailIn(BaseModel):
    owner_id: str | None = Field(default=None, max_length=256)
    title: str = Field(default="Health Report", max_length=200)
    subtitle: str = Field(default="", max_length=1000)
    pdf_base64: str = Field(min_length=1, max_length=11_000_000)
    pdf_filename: str = Field(default="report.pdf", max_length=200)


@router.post("/api/clinical/reports/email")
async def email_report_pdf(body: ReportEmailIn) -> dict[str, Any]:
    """Email the generated report PDF to the signed-in user's address."""
    owner = body.owner_id or _active_session.get("owner_id") or "guest"
    to = report_mailer.recipient_email(owner)
    try:
        pdf_bytes = base64.b64decode(body.pdf_base64, validate=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid pdf base64") from exc
    if not pdf_bytes.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="attachment must be a PDF")
    if not re.fullmatch(r"[^/\\\r\n]+\.pdf", body.pdf_filename, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="invalid PDF filename")
    try:
        await asyncio.to_thread(report_mailer.store_pdf, owner, body.title, pdf_bytes)
    except Exception:
        pass  # archiving is best-effort; the email itself must still go out
    html = report_mailer.build_email_html(body.title, body.subtitle, True)
    try:
        return await asyncio.to_thread(
            email_report.send_report_email,
            to=to,
            subject=body.title,
            html=html,
            pdf_base64=body.pdf_base64,
            pdf_filename=body.pdf_filename,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Resend email failed: {exc}")


@router.get("/api/clinical/reports/automation")
async def get_report_automation() -> dict[str, Any]:
    return {
        "enabled": report_mailer.get_automation(),
        "available": email_report.available(),
        "default_email": email_report.default_email(),
        "email": _active_session.get("email"),
    }


class AutomationIn(BaseModel):
    enabled: bool


@router.post("/api/clinical/reports/automation")
async def set_report_automation(body: AutomationIn) -> dict[str, Any]:
    return {"enabled": report_mailer.set_automation(body.enabled)}


class EmergencyContactIn(BaseModel):
    name: str = Field(default="", max_length=80)
    relation: str = Field(default="", max_length=40)
    phone: str = Field(default="", max_length=40)


class AlertProfileIn(BaseModel):
    role: str = Field(default="doctor", pattern="^(doctor|patient)$")
    clinician_id: str | None = Field(default=None, max_length=120)
    patient_id: str | None = Field(default=None, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=40)
    contacts: list[EmergencyContactIn] = Field(default_factory=list, max_length=8)


def _alert_owner(role: str, patient_id: str | None, clinician_id: str | None, display_name: str | None) -> str:
    return report_mailer.owner_key(role, patient_id, clinician_id, display_name)


@router.get("/api/clinical/settings/alert-profile")
async def get_alert_profile_settings(
    role: str = Query(default="doctor", pattern="^(doctor|patient)$"),
    clinician_id: str | None = Query(default=None),
    patient_id: str | None = Query(default=None),
    display_name: str | None = Query(default=None),
) -> dict[str, Any]:
    owner = _alert_owner(role, patient_id, clinician_id, display_name)
    return {
        **report_mailer.get_alert_profile(owner),
        "default_phone": report_mailer.default_alert_phone(),
        "fallback_configured": bool(load_env().get("ALERT_RECIPIENTS", "").strip()),
        "max_contacts": report_mailer.MAX_EMERGENCY_CONTACTS,
    }


@router.post("/api/clinical/settings/alert-profile")
async def save_alert_profile_settings(body: AlertProfileIn) -> dict[str, Any]:
    owner = _alert_owner(body.role, body.patient_id, body.clinician_id, body.display_name)
    try:
        profile = report_mailer.set_alert_profile(
            owner,
            name=body.name,
            email=body.email,
            phone=body.phone,
            contacts=body.contacts,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        **profile,
        "default_phone": report_mailer.default_alert_phone(),
        "fallback_configured": bool(load_env().get("ALERT_RECIPIENTS", "").strip()),
        "max_contacts": report_mailer.MAX_EMERGENCY_CONTACTS,
    }


class AlertPhoneIn(BaseModel):
    clinician_id: str | None = Field(default=None, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=40)


@router.get("/api/clinical/settings/alert-phone")
async def get_alert_phone_settings(
    clinician_id: str | None = Query(default=None),
    display_name: str | None = Query(default=None),
) -> dict[str, Any]:
    owner = report_mailer.owner_key("doctor", None, clinician_id, display_name)
    return {
        "phone": report_mailer.saved_alert_phone(owner),
        "default_phone": report_mailer.default_alert_phone(),
        "fallback_configured": bool(load_env().get("ALERT_RECIPIENTS", "").strip()),
    }


@router.post("/api/clinical/settings/alert-phone")
async def save_alert_phone_settings(body: AlertPhoneIn) -> dict[str, Any]:
    owner = report_mailer.owner_key("doctor", None, body.clinician_id, body.display_name)
    try:
        phone = report_mailer.set_alert_phone(owner, body.phone)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "phone": phone,
        "fallback_configured": bool(load_env().get("ALERT_RECIPIENTS", "").strip()),
    }


@router.post("/api/clinical/reports/send-weekly")
async def send_weekly_now() -> dict[str, Any]:
    """Manual trigger of the weekly report email (same path as the cron)."""
    results = await asyncio.to_thread(report_mailer.send_weekly)
    return {"results": results}


@router.post("/api/whatsapp/incoming")
@router.post("/api/clinical/whatsapp/webhook")
async def whatsapp_incoming_webhook(request: Request, service=Depends(clinical)) -> Response:
    raw = (await request.body()).decode("utf-8", errors="ignore")
    form = parse_qs(raw)
    question = (form.get("Body") or [""])[0].strip()
    if not question:
        twiml = "<Response><Message>Please send your health or patient question.</Message></Response>"
        return Response(content=twiml, media_type="application/xml")
    try:
        qa = await asyncio.to_thread(
            answer_clinical_doubt,
            service=service,
            question=question,
            active_session=_active_session,
        )
        reply = qa.get("answer") or "Unable to answer right now."
    except Exception:
        log.exception("WhatsApp question could not be answered")
        reply = (
            "Sorry, the health assistant can't answer right now. "
            "If this is urgent, contact your care team straight away."
        )
    twiml = f"<Response><Message>{escape(reply[:1550])}</Message></Response>"
    return Response(content=twiml, media_type="application/xml")


@router.post("/api/whatsapp/status")
async def whatsapp_status_callback(request: Request) -> Response:
    """Twilio delivery receipts; acknowledged so the sandbox does not retry."""
    form = parse_qs((await request.body()).decode("utf-8", errors="ignore"))
    log.info(
        "WhatsApp delivery %s to %s",
        (form.get("MessageStatus") or [""])[0],
        (form.get("To") or [""])[0],
    )
    return Response(status_code=204)