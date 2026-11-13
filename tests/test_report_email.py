import base64
from datetime import datetime, timedelta
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from backend.app.api import clinical
from backend.app.services import report_mailer


@pytest.fixture
def email_client(monkeypatch, tmp_path):
    monkeypatch.setattr(report_mailer, "STATE_FILE", tmp_path / "mail.json")
    monkeypatch.setattr(clinical, "_active_session", {})
    archive = Mock(return_value="pdfs/test.pdf")
    send = Mock(return_value={"sent": True, "id": "test-id"})
    monkeypatch.setattr(report_mailer, "store_pdf", archive)
    monkeypatch.setattr(clinical.email_report, "send_report_email", send)
    monkeypatch.setattr(clinical.email_report, "default_email", lambda: "default@example.com")
    app = FastAPI()
    app.include_router(clinical.router)
    with TestClient(app) as client:
        yield client, send, archive


def test_capture_email_default_and_reject_invalid(email_client):
    client, _, _ = email_client
    body = {"role": "patient", "patient_id": "p1", "display_name": "Patient"}
    assert client.post("/api/clinical/session/active", json=body).json()["email"] == "default@example.com"
    body["email"] = " patient@example.com "
    assert client.post("/api/clinical/session/active", json=body).json()["email"] == "patient@example.com"
    body["email"] = "not an email"
    assert client.post("/api/clinical/session/active", json=body).status_code == 422


def test_explicit_owner_pdf_attachment_and_escaped_html(email_client):
    client, send, archive = email_client
    for patient_id in ("p1", "p2"):
        client.post("/api/clinical/session/active", json={
            "role": "patient", "patient_id": patient_id, "email": f"{patient_id}@example.com",
        })
    pdf = base64.b64encode(b"%PDF-1.4\nsynthetic test attachment").decode()
    result = client.post("/api/clinical/reports/email", json={
        "owner_id": "patient:p1", "title": "<img src=x onerror=alert(1)>",
        "subtitle": "<script>bad</script>", "pdf_base64": pdf, "pdf_filename": "test.pdf",
    })
    assert result.status_code == 200
    assert send.call_args.kwargs["to"] == "p1@example.com"
    assert send.call_args.kwargs["pdf_base64"] == pdf
    assert "<img" not in send.call_args.kwargs["html"]
    assert "<script>" not in send.call_args.kwargs["html"]
    archive.assert_called_once()


@pytest.mark.parametrize("body", [
    {"pdf_base64": "invalid-base64"},
    {"pdf_base64": base64.b64encode(b"not a PDF").decode()},
    {"pdf_base64": base64.b64encode(b"%PDF-1.4").decode(), "pdf_filename": "../file.pdf"},
])
def test_reject_invalid_attachments_before_sending(email_client, body):
    client, send, archive = email_client
    assert client.post("/api/clinical/reports/email", json=body).status_code == 400
    send.assert_not_called()
    archive.assert_not_called()


def test_weekly_toggle_due_and_latest_pdf(email_client, monkeypatch):
    client, send, _ = email_client
    assert client.get("/api/clinical/reports/automation").json()["enabled"] is False
    client.post("/api/clinical/session/active", json={
        "role": "doctor", "clinician_id": "d1", "display_name": "Doctor", "email": "doctor@example.com",
    })
    assert client.post("/api/clinical/reports/automation", json={"enabled": True}).json()["enabled"]
    monkeypatch.setattr(report_mailer, "latest_pdf", lambda owner: ("latest.pdf", "JVBERi0xLjQ="))
    result = client.post("/api/clinical/reports/send-weekly").json()
    assert result["results"][0]["sent"] is True
    assert send.call_args.kwargs["to"] == "doctor@example.com"
    assert send.call_args.kwargs["pdf_filename"] == "latest.pdf"
    assert not report_mailer._due(report_mailer._load())
    old = (datetime.utcnow() - timedelta(days=8)).isoformat() + "Z"
    assert report_mailer._due({"last_sent": old})
    client.post("/api/clinical/reports/automation", json={"enabled": False})
    assert report_mailer.get_automation() is False


def test_weekly_preserves_settings_changed_during_delivery(email_client, monkeypatch):
    _, send, _ = email_client
    report_mailer.register_recipient("patient:p1", "patient", "First", "first@example.com")
    report_mailer.set_automation(True)
    monkeypatch.setattr(report_mailer, "latest_pdf", lambda owner: ("latest.pdf", "JVBERi0xLjQ="))

    def deliver(**kwargs):
        report_mailer.register_recipient("patient:p2", "patient", "Second", "second@example.com")
        report_mailer.set_automation(False)
        return {"sent": True}

    send.side_effect = deliver
    report_mailer.send_weekly()
    state = report_mailer._load()
    assert state["automation"] is False
    assert state["recipients"]["patient:p2"]["email"] == "second@example.com"
    assert state["last_sent"] is not None
    send.assert_called_once()
