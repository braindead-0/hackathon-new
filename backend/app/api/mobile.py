from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from backend.app.api.deps import Container, get_container
from backend.app.api.devices import server_urls
from backend.app.services.mobile_alerts import MobileAuthError, MobileRateLimit

router = APIRouter(prefix="/api/clinical/mobile", tags=["mobile alerts"])


class PairingIn(BaseModel):
    patient_id: str = Field(min_length=1, max_length=128)


class ClaimIn(BaseModel):
    code: str = Field(pattern=r"^[0-9]{6}$")


def _patient(c: Container, patient_id: str):
    if c.clinical is None:
        raise HTTPException(status_code=503, detail="Clinical service not configured")
    try:
        return c.clinical.patient(patient_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Patient no longer available; pair again") from exc


def _token(authorization: str | None) -> str:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="A paired device token is required")
    return token.strip()


@router.post("/pairings")
def create_pairing(body: PairingIn, request: Request, response: Response,
                   c: Container = Depends(get_container)) -> dict[str, Any]:
    patient = _patient(c, body.patient_id)
    response.headers["Cache-Control"] = "no-store"
    return {
        **c.mobile_alerts.create_pairing(body.patient_id, patient.profile.display_name),
        "server_urls": server_urls(request),
    }


@router.post("/claim")
def claim(body: ClaimIn, request: Request, response: Response,
          c: Container = Depends(get_container)) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    try:
        return c.mobile_alerts.claim(body.code, request.client.host if request.client else "unknown")
    except MobileRateLimit as exc:
        raise HTTPException(status_code=429, detail=str(exc), headers={"Retry-After": "60"}) from exc
    except MobileAuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@router.get("/feed")
def feed(response: Response, after: int = Query(default=0, ge=0),
         authorization: str | None = Header(default=None),
         c: Container = Depends(get_container)) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    try:
        result = c.mobile_alerts.feed(_token(authorization), after)
    except MobileAuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    patient = _patient(c, result.pop("patient_id"))
    reading = patient.readings[-1] if patient.readings else None
    return {
        **result,
        "patient": {
            "id": patient.profile.patient_id, "name": patient.profile.display_name,
            "timestamp": reading.timestamp.isoformat() if reading else None,
            "vitals": {metric: getattr(reading, metric, None)
                       for metric in ("heart_rate", "spo2", "respiratory_rate", "temperature")},
        },
    }


@router.delete("/connection")
def disconnect(authorization: str | None = Header(default=None),
               c: Container = Depends(get_container)) -> dict[str, bool]:
    try:
        c.mobile_alerts.disconnect(_token(authorization))
    except MobileAuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    return {"disconnected": True}


@router.get("/patients/{patient_id}/status")
def status(patient_id: str, response: Response,
           c: Container = Depends(get_container)) -> dict[str, int]:
    _patient(c, patient_id)
    response.headers["Cache-Control"] = "no-store"
    return c.mobile_alerts.status(patient_id)
