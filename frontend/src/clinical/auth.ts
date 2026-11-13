export type AuthSession =
  | {
      role: "doctor";
      clinicianName: string;
      clinicianId: string;
      email?: string;
    }
  | {
      role: "patient";
      patientId: string;
      patientName: string;
      email?: string;
    };

/** Capture this tab's identity; never infer report recipients from server-global state. */
export function activeSessionInput(session: AuthSession | null) {
  return {
    role: session?.role ?? null,
    display_name: session?.role === "doctor"
      ? session.clinicianName
      : session?.patientName ?? null,
    patient_id: session?.role === "patient" ? session.patientId : null,
    clinician_id: session?.role === "doctor" ? session.clinicianId : null,
    email: session?.email?.trim() || null,
  };
}

const SESSION_KEY = "ps03.auth.session";

export function loadSession(): AuthSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (parsed.role === "doctor" && parsed.clinicianName) return parsed;
    if (parsed.role === "patient" && parsed.patientId) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveSession(session: AuthSession): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* ignore storage errors */
  }
}

export function clearSession(): void {
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore storage errors */
  }
}
