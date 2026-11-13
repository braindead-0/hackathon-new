from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from backend.app.api import clinical, mobile
from backend.app.api.deps import get_container
from backend.app.services import report_mailer
from backend.app.services.mobile_alerts import MobileAlerts, MobileAuthError, MobileRateLimit


def publish(service, patient="a", tier="URGENT"):
    return service.publish(patient_id=patient, event_id="message-job", tier=tier,
                           patient_name="Test Patient", vitals={"heart_rate": 148}, text="Review vitals")


def pair(service, patient="a"):
    code = service.create_pairing(patient, "Test Patient")["code"]
    return service.claim(code, "127.0.0.1")


def test_patient_scope_cursor_and_single_use():
    service = MobileAlerts()
    publish(service)
    code = service.create_pairing("a", "Test Patient")["code"]
    device = service.claim(code, "127.0.0.1")
    with pytest.raises(MobileAuthError):
        service.claim(code, "127.0.0.1")
    assert service.feed(device["token"], device["cursor"])["events"] == []
    publish(service, "b")
    queued = publish(service)
    feed = service.feed(device["token"], device["cursor"])
    assert len(feed["events"]) == 1
    assert feed["events"][0]["event_id"] == queued["event_id"]
    assert feed["events"][0]["phase"] == "urgent"
    assert "patient_id" not in feed["events"][0]
    assert service.feed(device["token"], feed["cursor"])["events"] == []


def test_expiration_presence_and_disconnect(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("backend.app.services.mobile_alerts.time.monotonic", lambda: clock[0])
    service = MobileAlerts()
    device = pair(service)
    assert service.status("a") == {"paired": 1, "connected": 0}
    service.feed(device["token"], 0)
    assert service.status("a")["connected"] == 1
    publish(service)
    clock[0] += 11
    assert service.status("a")["connected"] == 0
    clock[0] += 120
    assert service.feed(device["token"], 0)["events"] == []
    assert service.feed(device["token"], 0)["cursor"] == 1
    service.disconnect(device["token"])
    with pytest.raises(MobileAuthError):
        service.feed(device["token"], 0)
    device = pair(service)
    clock[0] += service.SESSION_SECONDS + 1
    with pytest.raises(MobileAuthError):
        service.feed(device["token"], 0)


def test_pairing_expiration_replacement_and_rate_limit(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr("backend.app.services.mobile_alerts.time.monotonic", lambda: clock[0])
    service = MobileAlerts()
    first = service.create_pairing("a", "Test")["code"]
    second = service.create_pairing("a", "Test")["code"]
    assert first not in service._pairings or first == second
    clock[0] = 601
    with pytest.raises(MobileAuthError):
        service.claim(second, "host")
    for _ in range(4):
        with pytest.raises(MobileAuthError):
            service.claim("invalid", "host")
    with pytest.raises(MobileRateLimit):
        service.claim("invalid", "host")
    clock[0] += 61
    with pytest.raises(MobileAuthError):
        service.claim("invalid", "host")


@pytest.fixture
def mobile_client(monkeypatch, tmp_path):
    monkeypatch.setattr(report_mailer, "STATE_FILE", tmp_path / "alert_state.json")
    monkeypatch.setattr(report_mailer, "default_alert_phone", lambda: None)
    patient = SimpleNamespace(
        profile=SimpleNamespace(patient_id="a", display_name="Test Patient"),
        last_processed=None, stored_observations=0,
        readings=[SimpleNamespace(timestamp=datetime(2026, 11, 13), heart_rate=72)],
    )
    result = SimpleNamespace(
        tier=SimpleNamespace(value="URGENT"), alert_kind=SimpleNamespace(value="CLINICAL"),
        suppressed=False, news2=None, explanation=None, drift=[],
        to_dict=lambda: {"tier": "URGENT"},
    )

    def get_patient(patient_id):
        if patient_id != "a":
            raise KeyError(patient_id)
        return patient

    service = SimpleNamespace(patient=get_patient, _score_timestamp=Mock(return_value=result),
                              hapi=SimpleNamespace(store_bundle=AsyncMock()))
    container = SimpleNamespace(clinical=service, mobile_alerts=MobileAlerts())
    wa = Mock(return_value={"sent": True})
    tg = Mock(return_value={"sent": True})
    monkeypatch.setattr(clinical, "send_whatsapp_alert", wa)
    monkeypatch.setattr(clinical, "send_telegram_alert", tg)
    monkeypatch.setattr(clinical, "compare_with_xgboost", lambda **kwargs: {})
    app = FastAPI()
    app.include_router(mobile.router)
    app.include_router(clinical.router)
    app.dependency_overrides[get_container] = lambda: container
    with TestClient(app) as client:
        yield client, container.mobile_alerts, result, wa, tg


def post_reading(client, notify=True):
    return client.post("/api/clinical/patients/a/readings", json={
        "timestamp": "2026-11-13T10:00:00Z", "heart_rate": 148, "spo2": 84,
        "respiratory_rate": 28, "temperature": 37.3,
        "source": "smartwatch_demo", "send_whatsapp": notify,
    })


@pytest.mark.parametrize("tier", ["WATCH", "REVIEW", "URGENT"])
def test_reading_uses_same_event_for_mobile_and_messages(mobile_client, tier):
    client, service, result, wa, tg = mobile_client
    result.tier.value = tier
    device = pair(service)
    response = post_reading(client)
    assert response.status_code == 200
    data = response.json()
    events = service.feed(device["token"], device["cursor"])["events"]
    assert len(events) == 1
    assert events[0]["event_id"] == data["whatsapp"]["job_id"] == data["mobile"]["event_id"]
    assert events[0]["phase"] == tier.lower()
    assert events[0]["vitals"]["heart_rate"] == 148
    assert wa.call_args.kwargs["vitals"] == events[0]["vitals"]
    assert tg.call_args.kwargs["tier"] == tier


@pytest.mark.parametrize("tier,kind,suppressed,notify", [
    ("NORMAL", "CLINICAL", False, True),
    ("URGENT", "SENSOR", False, True),
    ("URGENT", "DEVICE_OFFLINE", False, True),
    ("URGENT", "CLINICAL", True, True),
    ("URGENT", "CLINICAL", False, False),
])
def test_no_mobile_alarm_when_messages_are_suppressed(mobile_client, tier, kind, suppressed, notify):
    client, service, result, wa, tg = mobile_client
    result.tier.value, result.alert_kind.value, result.suppressed = tier, kind, suppressed
    device = pair(service)
    response = post_reading(client, notify)
    assert response.status_code == 200
    assert "mobile" not in response.json()
    assert service.feed(device["token"], 0)["events"] == []
    wa.assert_not_called()
    tg.assert_not_called()


def test_message_failure_does_not_block_other_channels(mobile_client):
    client, service, _, wa, tg = mobile_client
    wa.side_effect = RuntimeError("Provider unavailable")
    device = pair(service)
    data = post_reading(client).json()
    assert service.feed(device["token"], 0)["events"]
    tg.assert_called_once()
    job = client.get(f"/api/clinical/whatsapp/{data['whatsapp']['job_id']}").json()
    assert job["sent"] is False
    assert job["telegram"]["sent"] is True


def test_mobile_routes_require_token_and_scope_patient(mobile_client):
    client, service, _, _, _ = mobile_client
    assert client.get("/api/clinical/mobile/feed").status_code == 401
    assert client.get("/api/clinical/mobile/feed", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/api/clinical/mobile/pairings", json={"patient_id": "missing"}).status_code == 404
    pairing = client.post("/api/clinical/mobile/pairings", json={"patient_id": "a"})
    assert pairing.headers["cache-control"] == "no-store"
    claim = client.post("/api/clinical/mobile/claim", json={"code": pairing.json()["code"]})
    device = claim.json()
    headers = {"Authorization": f"Bearer {device['token']}"}
    feed = client.get("/api/clinical/mobile/feed", headers=headers)
    assert feed.status_code == 200
    assert feed.headers["cache-control"] == "no-store"
    assert feed.json()["patient"]["id"] == "a"
    assert feed.json()["patient"]["vitals"]["heart_rate"] == 72
    assert client.get("/api/clinical/mobile/feed?after=-1", headers=headers).status_code == 422
    assert client.delete("/api/clinical/mobile/connection", headers=headers).status_code == 200
    assert client.get("/api/clinical/mobile/feed", headers=headers).status_code == 401


def test_urgent_alert_notifies_patient_and_clinician(mobile_client):
    client, service, result, wa, tg = mobile_client
    calls = []

    def fake_wa(**kwargs):
        calls.append(kwargs)
        return {"sent": True, "recipients": [kwargs.get("recipient_override") or "doctor"]}

    wa.side_effect = fake_wa
    response = client.post("/api/clinical/patients/a/readings", json={
        "timestamp": "2026-11-13T10:00:00Z", "heart_rate": 148, "spo2": 84,
        "respiratory_rate": 28, "temperature": 37.3,
        "source": "smartwatch_demo", "send_whatsapp": True,
        "whatsapp_to": "+910000000001",
    })
    job = client.get(f"/api/clinical/whatsapp/{response.json()['whatsapp']['job_id']}").json()
    assert job["sent"] is True
    assert job["patient"]["sent"] is True
    assert job["telegram"]["sent"] is True
    assert sorted(c["audience"] for c in calls) == ["clinician", "patient"]
    patient_call = next(c for c in calls if c["audience"] == "patient")
    clinician_call = next(c for c in calls if c["audience"] == "clinician")
    assert patient_call["recipient_override"] == "+910000000001"
    assert clinician_call.get("recipient_override") is None


def test_clinician_alert_phone_setting_round_trip(monkeypatch, tmp_path):
    monkeypatch.setattr(report_mailer, "STATE_FILE", tmp_path / "alert_state.json")
    app = FastAPI()
    app.include_router(clinical.router)
    with TestClient(app) as client:
        initial = client.get(
            "/api/clinical/settings/alert-phone",
            params={"clinician_id": "dr-a", "display_name": "Dr. Rao"},
        ).json()
        assert initial["phone"] is None
        assert isinstance(initial["default_phone"], (str, type(None)))
        assert isinstance(initial["fallback_configured"], bool)
        rejected = client.post("/api/clinical/settings/alert-phone", json={
            "clinician_id": "dr-a", "phone": "not-a-number",
        })
        assert rejected.status_code == 422
        saved = client.post("/api/clinical/settings/alert-phone", json={
            "clinician_id": "dr-a", "display_name": "Dr. Rao", "phone": "+91 90000 00009",
        }).json()
        assert saved["phone"] == "+919000000009"
        assert client.get(
            "/api/clinical/settings/alert-phone", params={"clinician_id": "dr-a"},
        ).json()["phone"] == "+919000000009"
        cleared = client.post("/api/clinical/settings/alert-phone", json={
            "clinician_id": "dr-a", "phone": "",
        }).json()
        assert cleared["phone"] is None


def test_alert_profile_with_emergency_contacts_round_trip(monkeypatch, tmp_path):
    monkeypatch.setattr(report_mailer, "STATE_FILE", tmp_path / "alert_state.json")
    app = FastAPI()
    app.include_router(clinical.router)
    with TestClient(app) as client:
        missing_phone = client.post("/api/clinical/settings/alert-profile", json={
            "role": "doctor", "clinician_id": "dr-a",
            "contacts": [{"name": "Ravi Rao", "relation": "Spouse", "phone": ""}],
        })
        assert missing_phone.status_code == 422
        bad_email = client.post("/api/clinical/settings/alert-profile", json={
            "role": "doctor", "clinician_id": "dr-a", "email": "not-an-email",
        })
        assert bad_email.status_code == 422
        saved = client.post("/api/clinical/settings/alert-profile", json={
            "role": "doctor", "clinician_id": "dr-a", "display_name": "Dr. Rao",
            "name": "Dr. Asha Rao", "email": "asha@example.com", "phone": "+91 90000 00009",
            "contacts": [
                {"name": "Ravi Rao", "relation": "Spouse", "phone": "+91 90000 00010"},
                {"name": "Ravi Rao", "relation": "Spouse", "phone": "+919000000010"},
            ],
        })
        assert saved.status_code == 200
        data = saved.json()
        assert data["phone"] == "+919000000009"
        assert data["email"] == "asha@example.com"
        assert data["contacts"] == [
            {"name": "Ravi Rao", "relation": "Spouse", "phone": "+919000000010"},
        ]
        fetched = client.get(
            "/api/clinical/settings/alert-profile", params={"role": "doctor", "clinician_id": "dr-a"},
        ).json()
        assert fetched["name"] == "Dr. Asha Rao"
        assert fetched["contacts"][0]["phone"] == "+919000000010"
        assert fetched["max_contacts"] == report_mailer.MAX_EMERGENCY_CONTACTS


def test_urgent_alert_messages_emergency_contacts(mobile_client):
    client, _, _, wa, _ = mobile_client
    report_mailer.set_alert_profile(
        "doctor:dr-a", name="Dr. Asha Rao", phone="+919000000009",
        contacts=[{"name": "Ravi Rao", "relation": "Spouse", "phone": "+919000000010"}],
    )
    report_mailer.set_alert_profile(
        "patient:a", name="Test Patient", phone="+910000000001",
        contacts=[{"name": "Meera Rao", "relation": "Daughter", "phone": "+919000000011"}],
    )
    calls = []

    def fake_wa(**kwargs):
        calls.append(kwargs)
        return {"sent": True}

    wa.side_effect = fake_wa
    response = post_reading(client)
    assert response.status_code == 200
    job = client.get(f"/api/clinical/whatsapp/{response.json()['whatsapp']['job_id']}").json()
    assert set(job["contacts"]) == {"+919000000010", "+919000000011"}
    family = [c for c in calls if c["audience"] == "family"]
    assert {c["recipient_override"] for c in family} == {"+919000000010", "+919000000011"}
    assert {c["contact_name"] for c in family} == {"Ravi Rao", "Meera Rao"}
    # the clinician and patient numbers are never duplicated by a contact entry
    assert len([c for c in calls if c["audience"] == "clinician"]) == 1
    assert len([c for c in calls if c["audience"] == "patient"]) == 1


def test_urgent_alert_routes_clinician_to_saved_phone(mobile_client):
    client, _, _, wa, _ = mobile_client
    report_mailer.set_alert_phone("doctor:dr-a", "+919000000009")
    calls = []

    def fake_wa(**kwargs):
        calls.append(kwargs)
        return {"sent": True}

    wa.side_effect = fake_wa
    response = post_reading(client)
    assert response.status_code == 200
    clinician_call = next(c for c in calls if c["audience"] == "clinician")
    assert clinician_call["recipient_override"] == "+919000000009"


def test_urgent_alert_falls_back_to_server_default_clinician_phone(mobile_client, monkeypatch):
    client, _, _, wa, _ = mobile_client
    monkeypatch.setattr(report_mailer, "default_alert_phone", lambda: "+919483113397")
    calls = []

    def fake_wa(**kwargs):
        calls.append(kwargs)
        return {"sent": True}

    wa.side_effect = fake_wa
    assert post_reading(client).status_code == 200
    clinician_call = next(c for c in calls if c["audience"] == "clinician")
    assert clinician_call["recipient_override"] == "+919483113397"


def test_urgent_alert_template_for_patient_and_clinician():
    from backend.app.services.whatsapp import format_alert

    kwargs = dict(
        patient_name="Todd Carlton Grant", patient_id="p-todd", tier="URGENT",
        news2_total=9, risk_level="HIGH RISK",
        vitals={"respiratory_rate": 28, "heart_rate": 158, "spo2": 84, "temperature": 37.3},
        narrative="Respiratory rate and pulse are climbing while oxygen is falling.",
    )
    patient = format_alert(**kwargs, audience="patient")
    assert patient.startswith("⚠️ VITALTWIN | URGENT HEALTH ALERT")
    assert "Hello Todd," in patient
    assert "📊 Current Health Readings" in patient
    assert "• Respiratory Rate: 28 breaths/min (High)" in patient
    assert "• Heart Rate: 158 bpm (Critically High)" in patient
    assert "• SpO₂: 84% (Critically Low)" in patient
    assert "🚨 NEWS2 Score: 9 — HIGH RISK" in patient
    assert "Immediate Action Required" in patient
    assert "— VitalTwin Clinical Care Team" in patient

    clinician = format_alert(**kwargs, audience="clinician")
    assert clinician.startswith("⚠️ VITALTWIN | URGENT CLINICAL ALERT")
    assert "Patient: Todd Carlton Grant (p-todd)" in clinician
    assert "📊 Current Readings" in clinician
    assert "🚨 NEWS2 Score: 9 — HIGH RISK" in clinician
    assert "Review immediately and escalate per local protocol." in clinician

    family = format_alert(**kwargs, audience="family", contact_name="Meera Grant")
    assert family.startswith("⚠️ VITALTWIN | URGENT EMERGENCY ALERT")
    assert "Hello Meera Grant," in family
    assert "About: Todd Carlton Grant" in family
    assert "p-todd" not in family
    assert "You are listed as an emergency contact." in family
    assert "🚨 NEWS2 Score: 9 — HIGH RISK" in family
    assert "— VitalTwin Clinical Care Team" in family


def test_saving_report_uses_saved_clinician_phone(monkeypatch, tmp_path):
    monkeypatch.setattr(report_mailer, "STATE_FILE", tmp_path / "alert_state.json")
    monkeypatch.setattr(report_mailer, "default_alert_phone", lambda: None)
    monkeypatch.setattr(clinical, "_patient_contacts", {})
    sent: list[tuple[str, str | None]] = []
    monkeypatch.setattr(clinical.insforge_storage, "upload_bytes", lambda *a, **k: {"url": None})
    monkeypatch.setattr(
        clinical, "send_whatsapp_text",
        lambda text, to=None: sent.append(("wa", to)) or {"sent": True},
    )
    monkeypatch.setattr(clinical, "send_telegram_text", lambda text: {"sent": True})
    report_mailer.set_alert_phone("doctor:dr-a", "+919000000009")
    service = SimpleNamespace(patient=lambda patient_id: SimpleNamespace(
        profile=SimpleNamespace(display_name="Test Patient"),
    ))
    app = FastAPI()
    app.include_router(clinical.router)
    app.dependency_overrides[get_container] = lambda: SimpleNamespace(clinical=service)
    with TestClient(app) as client:
        response = client.post("/api/clinical/reports/record", json={
            "patient_id": "p1", "clinician_id": "dr-a",
            "report": {"title": "Clinical Report", "doctorNotes": {"editedBy": "Dr. Rao"}},
        })
    assert response.status_code == 200
    assert {to for _, to in sent} == {"+919000000009"}


def test_saving_report_notifies_patient_and_clinician(monkeypatch, tmp_path):
    monkeypatch.setattr(report_mailer, "STATE_FILE", tmp_path / "alert_state.json")
    monkeypatch.setattr(report_mailer, "default_alert_phone", lambda: None)
    sent: list[tuple[str, str | None]] = []
    monkeypatch.setitem(clinical._patient_contacts, "p1", "+910000000002")
    monkeypatch.setattr(clinical.insforge_storage, "upload_bytes", lambda *a, **k: {"url": None})
    monkeypatch.setattr(
        clinical, "send_whatsapp_text",
        lambda text, to=None: sent.append(("wa", to)) or {"sent": True},
    )
    monkeypatch.setattr(clinical, "send_telegram_text", lambda text: {"sent": True})

    patient = SimpleNamespace(profile=SimpleNamespace(display_name="Test Patient"))
    service = SimpleNamespace(patient=lambda patient_id: patient)
    app = FastAPI()
    app.include_router(clinical.router)
    app.dependency_overrides[get_container] = lambda: SimpleNamespace(clinical=service)

    with TestClient(app) as client:
        response = client.post("/api/clinical/reports/record", json={
            "patient_id": "p1",
            "report": {"title": "Clinical Report", "doctorNotes": {"editedBy": "Dr. Rao"}},
            "patient_summary": "# Summary\n- **Oxygen** is low at 90.2%.",
        })
    assert response.status_code == 200
    notified = response.json()["notified"]
    assert notified["patient"]["sent"] is True
    assert notified["clinician"]["sent"] is True
    assert sorted("patient" if to else "clinician" for _, to in sent) == ["clinician", "patient"]
