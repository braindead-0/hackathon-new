from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from hashlib import sha256
import secrets
from threading import RLock
import time
from typing import Any


class MobileAuthError(ValueError):
    pass


class MobileRateLimit(ValueError):
    pass


class MobileAlerts:
    PAIRING_SECONDS = 600
    SESSION_SECONDS = 86400
    EVENT_SECONDS = 120

    def __init__(self) -> None:
        self._lock = RLock()
        self._pairings: dict[str, dict[str, Any]] = {}
        self._sessions: dict[str, dict[str, Any]] = {}
        self._attempts: dict[str, deque[float]] = {}
        self._events: deque[dict[str, Any]] = deque(maxlen=1000)
        self._cursor = 0

    def _prune(self, now: float) -> None:
        for collection in (self._pairings, self._sessions):
            for key in list(collection):
                if collection[key]["expires"] <= now:
                    del collection[key]
        for host in list(self._attempts):
            if not self._attempts[host] or self._attempts[host][-1] <= now - 60:
                del self._attempts[host]
        while self._events and self._events[0]["created"] <= now - self.EVENT_SECONDS:
            self._events.popleft()

    def create_pairing(self, patient_id: str, patient_name: str) -> dict[str, Any]:
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            for code in list(self._pairings):
                if self._pairings[code]["patient_id"] == patient_id:
                    del self._pairings[code]
            code = f"{secrets.randbelow(1_000_000):06d}"
            while code in self._pairings:
                code = f"{secrets.randbelow(1_000_000):06d}"
            self._pairings[code] = {
                "patient_id": patient_id, "patient_name": patient_name,
                "expires": now + self.PAIRING_SECONDS,
            }
            return {"code": code, "expires_in": self.PAIRING_SECONDS}

    def claim(self, code: str, host: str) -> dict[str, Any]:
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            attempts = self._attempts.setdefault(host, deque())
            while attempts and attempts[0] <= now - 60:
                attempts.popleft()
            if len(attempts) >= 5:
                raise MobileRateLimit("Too many pairing attempts. Try again in one minute.")
            attempts.append(now)
            pairing = self._pairings.pop(code, None)
            if pairing is None:
                raise MobileAuthError("Pairing code is invalid or expired. Generate a new code.")
            token = secrets.token_urlsafe(32)
            self._sessions[sha256(token.encode()).hexdigest()] = {
                **pairing, "expires": now + self.SESSION_SECONDS, "last_seen": None,
            }
            return {
                "token": token, "patient_id": pairing["patient_id"],
                "patient_name": pairing["patient_name"], "cursor": self._cursor,
                "expires_in": self.SESSION_SECONDS,
            }

    def _session(self, token: str) -> dict[str, Any]:
        session = self._sessions.get(sha256(token.encode()).hexdigest())
        if session is None:
            raise MobileAuthError("Pairing expired or disconnected. Generate a new code.")
        return session

    def feed(self, token: str, after: int) -> dict[str, Any]:
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            session = self._session(token)
            session["last_seen"] = now
            events = [
                {k: v for k, v in event.items() if k not in ("created", "patient_id")}
                for event in self._events
                if event["patient_id"] == session["patient_id"] and event["id"] > after
            ]
            return {"patient_id": session["patient_id"], "cursor": self._cursor, "events": events}

    def disconnect(self, token: str) -> None:
        with self._lock:
            self._prune(time.monotonic())
            self._session(token)
            del self._sessions[sha256(token.encode()).hexdigest()]

    def status(self, patient_id: str) -> dict[str, int]:
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            sessions = [s for s in self._sessions.values() if s["patient_id"] == patient_id]
            return {
                "paired": len(sessions),
                "connected": sum(s["last_seen"] is not None and now - s["last_seen"] < 10 for s in sessions),
            }

    def publish(self, *, patient_id: str, event_id: str, tier: str, patient_name: str,
                vitals: dict[str, Any], text: str) -> dict[str, Any]:
        if tier not in ("WATCH", "REVIEW", "URGENT"):
            raise ValueError("Unsupported mobile alert tier")
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            self._cursor += 1
            self._events.append({
                "id": self._cursor, "event_id": event_id, "patient_id": patient_id,
                "phase": tier.lower(), "title": f"{tier} — {patient_name}",
                "text": text, "vitals": dict(vitals),
                "timestamp": datetime.now(timezone.utc).isoformat(), "created": now,
            })
            return {"event_id": event_id, "queued": True, **self.status(patient_id)}
