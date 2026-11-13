"""Server-side uploads to InsForge Storage (free-tier object storage).

Credentials come from the repo-root .env (INSFORGE_BASE_URL / INSFORGE_API_KEY,
server-only), falling back to the linked project's .insforge/project.json.
Uses the documented upload-strategy flow (direct or presigned).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx

from backend.app.services.envconf import get as env_get

REPO_ROOT = Path(__file__).resolve().parents[3]
PROJECT_FILE = REPO_ROOT / ".insforge" / "project.json"
DEFAULT_BUCKET = "health-reports"


def _project() -> dict[str, Any]:
    base = env_get("INSFORGE_BASE_URL")
    key = env_get("INSFORGE_API_KEY")
    if base and key:
        return {"oss_host": base, "api_key": key}
    if not PROJECT_FILE.exists():
        raise RuntimeError(
            "InsForge credentials missing: set INSFORGE_BASE_URL / INSFORGE_API_KEY in .env "
            "or link the project (.insforge/project.json)."
        )
    return json.loads(PROJECT_FILE.read_text(encoding="utf-8"))


def upload_bytes(
    key: str,
    data: bytes,
    content_type: str = "application/octet-stream",
    bucket: str = DEFAULT_BUCKET,
) -> dict[str, Any]:
    proj = _project()
    base = proj["oss_host"].rstrip("/")
    headers = {"Authorization": f"Bearer {proj['api_key']}"}
    with httpx.Client(timeout=60, trust_env=False) as client:
        strategy = client.post(
            f"{base}/api/storage/buckets/{bucket}/upload-strategy",
            headers={**headers, "Content-Type": "application/json"},
            json={"filename": key, "contentType": content_type, "size": len(data)},
        )
        strategy.raise_for_status()
        plan = strategy.json()
        files = {"file": (key, data, content_type)}
        if plan.get("method") == "presigned":
            resp = client.post(plan["uploadUrl"], data=plan.get("fields", {}), files=files)
            resp.raise_for_status()
            confirm = client.post(
                f"{base}{plan['confirmUrl']}",
                headers={**headers, "Content-Type": "application/json"},
                json={"size": len(data), "contentType": content_type},
            )
            confirm.raise_for_status()
            return confirm.json()
        resp = client.put(f"{base}{plan['uploadUrl']}", headers=headers, files=files)
        resp.raise_for_status()
        return resp.json()


def list_objects(
    prefix: str = "",
    bucket: str = DEFAULT_BUCKET,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    proj = _project()
    base = proj["oss_host"].rstrip("/")
    headers = {"Authorization": f"Bearer {proj['api_key']}"}
    with httpx.Client(timeout=60, trust_env=False) as client:
        resp = client.get(
            f"{base}/api/storage/buckets/{bucket}/objects",
            headers=headers,
            params={"prefix": prefix, "limit": limit, "offset": offset},
        )
        resp.raise_for_status()
        payload = resp.json()
    data = payload.get("data", payload) if isinstance(payload, dict) else payload
    return data if isinstance(data, list) else []


def download_bytes(key: str, bucket: str = DEFAULT_BUCKET) -> bytes:
    proj = _project()
    base = proj["oss_host"].rstrip("/")
    headers = {"Authorization": f"Bearer {proj['api_key']}"}
    with httpx.Client(timeout=60, trust_env=False, follow_redirects=True) as client:
        resp = client.get(
            f"{base}/api/storage/buckets/{bucket}/objects/{key}",
            headers=headers,
        )
        resp.raise_for_status()
        return resp.content