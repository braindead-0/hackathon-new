import type {
  FhirObservation,
  MonitorResult,
  Observation,
  PatientRow,
  PatientStatePayload,
  PerformanceReport,
  ReplayStatus,
} from "./types";
import type { GeneratedReport } from "./reportGenerator";

export interface ActiveSessionInput {
  role: "doctor" | "patient" | null;
  display_name: string | null;
  patient_id: string | null;
  clinician_id?: string | null;
  email?: string | null;
}

export interface ActiveSessionResult {
  ok: boolean;
  owner_id: string;
  email: string | null;
}

export interface ReportAutomation {
  enabled: boolean;
  available: boolean;
  default_email: string;
  /** Server-global active recipient; do not use as the current tab's identity. */
  email: string | null;
}

export interface EmergencyContact {
  name: string;
  relation: string;
  phone: string;
}

export interface AlertProfileSettings {
  name: string | null;
  email: string | null;
  phone: string | null;
  contacts: EmergencyContact[];
  default_phone: string | null;
  fallback_configured: boolean;
  max_contacts: number;
}

export interface AlertProfileIdentity {
  role: "doctor" | "patient";
  clinician_id?: string | null;
  patient_id?: string | null;
  display_name?: string | null;
}

export interface EmailReportInput {
  owner_id: string;
  title: string;
  subtitle: string;
  pdf_base64: string;
  pdf_filename: string;
}

export interface EmailReportResult {
  sent: boolean;
  id?: string | null;
  to?: string;
  error?: string;
}

export interface RecordSummary {
  key: string;
  title: string;
  kind: GeneratedReport["kind"] | null;
  generatedAt: string | null;
  editedAt: string | null;
  editedBy: string | null;
  modified: boolean;
  size: number | null;
  uploadedAt: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export interface XgbComparison {
  available: boolean;
  without_xgboost: {
    engine: string;
    tier: string;
    risk_score: number;
    news2_total: number | null;
    suppressed?: boolean;
  };
  with_xgboost: {
    engine: string;
    tier: string;
    risk_score: number;
    confidence: number;
    probabilities: Record<string, number>;
  } | null;
  agreement: string;
  score_delta: number | null;
  should_use_both: string;
}

export interface MobileAlertResult {
  event_id: string;
  queued: boolean;
  paired: number;
  connected: number;
}

export interface MobilePairing {
  code: string;
  expires_in: number;
  server_urls: string[];
}

export const clinicalApi = {
  pairMobile: (patientId: string) =>
    post<MobilePairing>("/api/clinical/mobile/pairings", { patient_id: patientId }),
  mobileStatus: (patientId: string) =>
    request<{ paired: number; connected: number }>(
      `/api/clinical/mobile/patients/${encodeURIComponent(patientId)}/status`,
    ),
  patients: () =>
    request<{ patients: PatientRow[]; disclaimer: string }>("/api/clinical/patients"),
  state: (id: string) => request<PatientStatePayload>(`/api/clinical/patients/${id}/state`),
  alerts: (id: string, limit = 60) =>
    request<{ alerts: MonitorResult[] }>(`/api/clinical/patients/${id}/alerts?limit=${limit}`),
  readings: (id: string, limit = 400) =>
    request<{ readings: Observation[] }>(`/api/clinical/patients/${id}/readings?limit=${limit}`),
  sendReading: (
    id: string,
    reading: {
      timestamp: string;
      heart_rate: number | null;
      spo2: number | null;
      respiratory_rate: number | null;
      temperature: number | null;
      activity_intensity?: number;
      source?: string;
      send_whatsapp?: boolean;
      whatsapp_to?: string | null;
    },
  ) =>
    post<
      (MonitorResult & {
        whatsapp?: {
          queued?: boolean;
          job_id?: string;
          sent: boolean;
          dry_run?: boolean;
          recipients?: string[];
          sids?: string[];
          error?: string;
        };
        xgboost?: XgbComparison;
        mobile?: MobileAlertResult;
      }) | { scored: boolean }
    >(`/api/clinical/patients/${id}/readings`, reading),
  patientXgb: (id: string) =>
    request<XgbComparison>(`/api/clinical/patients/${id}/xgboost`),
  storeReport: (body: { patient_id: string; title: string; html: string }) =>
    post<{ bucket: string; key: string; url: string | null }>(
      "/api/clinical/reports/store",
      body,
    ),
  saveRecord: (body: {
    patient_id: string;
    report: unknown;
    patient_summary?: string | null;
    whatsapp_to?: string | null;
    clinician_id?: string | null;
  }) =>
    post<{
      bucket: string;
      key: string;
      notified?: {
        patient?: { sent: boolean; error?: string; recipients?: string[] };
        clinician?: { sent: boolean; error?: string; recipients?: string[] } | null;
        telegram?: { sent: boolean; error?: string } | null;
      };
    }>("/api/clinical/reports/record", body),
  listRecords: (patientId: string) =>
    request<{ records: RecordSummary[] }>(
      `/api/clinical/reports/records?patient_id=${encodeURIComponent(patientId)}`,
    ),
  getRecord: (key: string) =>
    request<GeneratedReport>(
      `/api/clinical/reports/record?key=${encodeURIComponent(key)}`,
    ),
  sendWhatsappReport: (body: {
    title: string;
    summary_text: string;
    whatsapp_to?: string | null;
  }) =>
    post<{ queued: boolean; job_id: string; sent: boolean }>(
      "/api/clinical/whatsapp/report",
      body,
    ),
  whatsappStatus: (jobId: string) =>
    request<{
      queued?: boolean;
      sent: boolean;
      dry_run?: boolean;
      recipients?: string[];
      sids?: string[];
      error?: string;
      patient?: { sent: boolean; dry_run?: boolean; error?: string } | null;
      telegram?: { sent: boolean; dry_run?: boolean; error?: string } | null;
    }>(`/api/clinical/whatsapp/${jobId}`),
  setActiveSession: (body: ActiveSessionInput) =>
    post<ActiveSessionResult>("/api/clinical/session/active", body),
  emailReport: (body: EmailReportInput) =>
    post<EmailReportResult>("/api/clinical/reports/email", body),
  getReportAutomation: () =>
    request<ReportAutomation>("/api/clinical/reports/automation"),
  setReportAutomation: (body: { enabled: boolean }) =>
    post<{ enabled: boolean }>("/api/clinical/reports/automation", body),
  getAlertProfile: (identity: AlertProfileIdentity) => {
    const q = new URLSearchParams({ role: identity.role });
    if (identity.clinician_id) q.set("clinician_id", identity.clinician_id);
    if (identity.patient_id) q.set("patient_id", identity.patient_id);
    if (identity.display_name) q.set("display_name", identity.display_name);
    return request<AlertProfileSettings>(`/api/clinical/settings/alert-profile?${q}`);
  },
  setAlertProfile: (
    body: AlertProfileIdentity & {
      name?: string | null;
      email?: string | null;
      phone?: string | null;
      contacts: EmergencyContact[];
    },
  ) => post<AlertProfileSettings>("/api/clinical/settings/alert-profile", body),
  askWhatsapp: (body: {
    question: string;
    send_to_whatsapp?: boolean;
    whatsapp_to?: string | null;
    role?: string | null;
    display_name?: string | null;
    patient_id?: string | null;
  }) =>
    post<{
      answer: string;
      addressed_to: string;
      role: string;
      patient_name: string | null;
      patient_id: string | null;
      whatsapp?: { queued?: boolean; job_id?: string; sent: boolean };
    }>("/api/clinical/whatsapp/ask", body),
  replayStatus: () => request<ReplayStatus>("/api/clinical/replay/status"),
  replayStart: (patientIds?: string[]) =>
    post<ReplayStatus>("/api/clinical/replay/start", { patient_ids: patientIds ?? null }),
  replayStop: () => post<ReplayStatus>("/api/clinical/replay/stop"),
  replayReset: () => post<ReplayStatus>("/api/clinical/replay/reset"),
  report: (refresh = false) =>
    request<PerformanceReport>(`/api/clinical/report${refresh ? "?refresh=true" : ""}`),
  hapiHealth: () =>
    request<{ healthy: boolean; base_url: string }>("/api/clinical/hapi/health"),
  hapiObservations: (id: string, loinc?: string, count = 20) => {
    const q = new URLSearchParams({ count: String(count) });
    if (loinc) q.set("loinc", loinc);
    return request<{ total: number | null; entries: FhirObservation[] }>(
      `/api/clinical/hapi/observations/${id}?${q}`,
    );
  },
};

/** The four LOINC codes PS-03 §3.1 mandates, plus the two NEWS2 also uses. */
export const LOINC: Record<string, { code: string; label: string; unit: string }> = {
  heart_rate: { code: "8867-4", label: "Heart rate", unit: "bpm" },
  spo2: { code: "2708-6", label: "SpO₂", unit: "%" },
  respiratory_rate: { code: "9279-1", label: "Respiratory rate", unit: "br/min" },
  temperature: { code: "8310-5", label: "Body temperature", unit: "°C" },
  systolic_bp: { code: "8480-6", label: "Systolic BP", unit: "mmHg" },
  diastolic_bp: { code: "8462-4", label: "Diastolic BP", unit: "mmHg" },
};

export const METRIC_ORDER = [
  "heart_rate",
  "spo2",
  "respiratory_rate",
  "temperature",
  "systolic_bp",
] as const;

export type Metric = (typeof METRIC_ORDER)[number];

/** Resting reference ranges used to colour patient-facing vitals. */
export const VITAL_RANGE: Record<string, [number, number]> = {
  heart_rate: [60, 100],
  spo2: [95, 100],
  respiratory_rate: [12, 20],
  temperature: [36.1, 37.2],
  systolic_bp: [90, 140],
  diastolic_bp: [60, 90],
};

export const VITAL_COLOR: Record<string, string> = {
  heart_rate: "#e11d48",
  spo2: "#0284c7",
  respiratory_rate: "#0d9488",
  temperature: "#d97706",
  systolic_bp: "#7c3aed",
  diastolic_bp: "#7c3aed",
};

export type VitalTone = "ok" | "high" | "low" | "absent";

export function vitalStatus(
  metric: string,
  value: number | null | undefined,
): { tone: VitalTone; label: string } {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { tone: "absent", label: "Not reported" };
  }
  const range = VITAL_RANGE[metric];
  if (!range) return { tone: "ok", label: "Recorded" };
  if (value < range[0]) return { tone: "low", label: "Low" };
  if (value > range[1]) return { tone: "high", label: "High" };
  return { tone: "ok", label: "In range" };
}