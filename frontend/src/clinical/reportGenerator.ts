import { clinicalToTwinPayload, type WatchLiveOverride } from "./ClinicalTwin3D";
import type { AuthSession } from "./auth";
import type { MonitorResult, Observation, PatientRow, PatientStatePayload } from "./types";
import { SCENARIO_LABEL, TIER_LABEL, dateTime } from "./ui";

function fmtMetric(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return "—";
  return digits > 0 ? value.toFixed(digits) : String(Math.round(value));
}

export interface ReportTable {
  headers: string[];
  rows: string[][];
}

export interface ReportSection {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  table?: ReportTable;
}

export interface ReportVisualContext {
  state: PatientStatePayload;
  alerts: MonitorResult[];
  readings: Observation[];
  liveOverride?: WatchLiveOverride | null;
  session?: Extract<AuthSession, { role: "doctor" }> | null;
}

export type MetricKey = "heart_rate" | "spo2" | "respiratory_rate" | "temperature";

export interface OrganFinding {
  organ: string;
  metric: MetricKey;
  metricLabel: string;
  valueText: string;
  baselineText: string;
  status: "normal" | "watch" | "anomalous";
  summary: string;
}

/** Clinician-authored addendum that a doctor can edit and persist on a report. */
export interface DoctorNotes {
  assessment: string;
  plan: string;
  followUp: string;
  editedBy?: string;
  editedAt?: string;
}

export interface GeneratedReport {
  id: string;
  kind: "doctor-patient" | "doctor-ward" | "patient-summary";
  title: string;
  subtitle: string;
  generatedAt: string;
  authorLabel: string;
  filename: string;
  disclaimer: string;
  sections: ReportSection[];
  visualContext?: ReportVisualContext;
  doctorNotes?: DoctorNotes;
  /** Set when this report was reopened from a persisted record. */
  recordKey?: string;
}

const DEFAULT_DISCLAIMER =
  "Clinical decision support, not medical diagnosis. Synthetic data only (with optional BIDMC recorded replay).";

function nowIso(): string {
  return new Date().toISOString();
}

export function reportToMarkdown(report: GeneratedReport): string {
  const revision =
    report.doctorNotes?.editedBy || report.doctorNotes?.editedAt
      ? `- **Revised:** ${report.doctorNotes?.editedBy ?? "clinician"}${report.doctorNotes?.editedAt ? ` · ${dateTime(report.doctorNotes.editedAt)} UTC` : ""}`
      : null;
  const lines: string[] = [
    `# ${report.title}`,
    `_${report.subtitle}_`,
    "",
    `- **Generated:** ${dateTime(report.generatedAt)} UTC`,
    `- **Prepared for / by:** ${report.authorLabel}`,
    ...(revision ? [revision] : []),
    "",
    `> **Safety notice:** ${report.disclaimer}`,
    "",
  ];

  for (const sec of report.sections) {
    lines.push(`## ${sec.title}`, "");
    if (sec.paragraphs) {
      for (const p of sec.paragraphs) {
        lines.push(p, "");
      }
    }
    if (sec.bullets && sec.bullets.length > 0) {
      for (const b of sec.bullets) {
        lines.push(`- ${b}`);
      }
      lines.push("");
    }
    if (sec.table && sec.table.rows.length > 0) {
      lines.push(`| ${sec.table.headers.join(" | ")} |`);
      lines.push(`| ${sec.table.headers.map(() => "---").join(" | ")} |`);
      for (const row of sec.table.rows) {
        lines.push(`| ${row.join(" | ")} |`);
      }
      lines.push("");
    }
  }

  const notes = report.doctorNotes;
  if (notes && (notes.assessment || notes.plan || notes.followUp)) {
    lines.push("## Clinician addendum", "");
    if (notes.editedBy || notes.editedAt) {
      lines.push(
        `_Edited by ${notes.editedBy ?? "clinician"}${notes.editedAt ? ` · ${dateTime(notes.editedAt)} UTC` : ""}_`,
        "",
      );
    }
    if (notes.assessment) lines.push(`**Assessment:** ${notes.assessment}`, "");
    if (notes.plan) lines.push(`**Plan:** ${notes.plan}`, "");
    if (notes.followUp) lines.push(`**Follow-up:** ${notes.followUp}`, "");
  }
  return lines.join("\n");
}

export function buildDoctorPatientReport(
  state: PatientStatePayload,
  alerts: MonitorResult[],
  readings: Observation[],
  session?: Extract<AuthSession, { role: "doctor" }> | null,
): GeneratedReport {
  const p = state.profile;
  const generatedAt = nowIso();
  const clinician = session
    ? `${session.clinicianName} (${session.clinicianId})`
    : "Attending Clinician";

  const { flagged, normalLabels } = focusedFindings(state, readings, null, false);

  const statusSummary = !state.timestamp
    ? "Awaiting first wearable/replay observation."
    : state.suppressed
      ? `Clinical scoring withheld due to sensor artifact (${state.alert_kind ?? "SENSOR"}).`
      : `Tier ${TIER_LABEL[state.tier]} · NEWS2 ${state.news2?.total ?? "—"} (${state.news2?.risk_level ?? "not scored"}).`;

  const concernBullets = flagged.length
    ? flagged.map(
        (f) =>
          `${f.organ} — ${f.metricLabel} ${f.valueText} (${f.baselineText}; ${trendPhrase(f.trend, f.metric)}). ${f.summary}`,
      )
    : [
        state.suppressed
          ? "No trustworthy reading to score — verify sensor fit/connection before interpreting stability."
          : "No physiological system is currently flagged against the personal baseline or NEWS2 thresholds.",
      ];

  const vitalsRows: string[][] = [];
  if (state.news2?.parameters?.length) {
    for (const param of state.news2.parameters) {
      if (param.score === 0 && param.value !== null) continue;
      vitalsRows.push([
        param.label,
        param.value === null ? "missing (dataAbsentReason)" : `${param.value} ${param.unit}`.trim(),
        String(param.score),
        param.band,
      ]);
    }
  }

  const clinicalAlerts = alerts
    .filter((a) => a.alert_kind === "CLINICAL" && a.tier !== "NORMAL")
    .slice(0, 5);
  const sensorAlerts = alerts.filter((a) => a.alert_kind !== "CLINICAL").slice(0, 4);

  const sections: ReportSection[] = [
    {
      title: flagged.length ? `Immediate concerns (${flagged.length})` : "Immediate concerns",
      paragraphs: [statusSummary],
      bullets: concernBullets,
    },
    {
      title: "Clinical context",
      bullets: [
        `${p.display_name} (${p.patient_id}) · ${p.age_years}y ${p.sex} · discharged ${p.discharged_on} · ${SCENARIO_LABEL[p.scenario] ?? p.scenario}`,
        `Conditions: ${p.conditions.map((c) => c.display).join("; ") || "none documented"}`,
        `Medications: ${p.medications.map((m) => m.display).join("; ") || "none documented"}`,
        `Personalization: SpO₂ Scale ${p.spo2_scale} (target ${p.spo2_target[0]}–${p.spo2_target[1]}%)${p.beta_blocked ? ` · beta-blocker pulse +${p.pulse_correction_bpm} bpm` : ""}`,
        `FHIR Observations stored: ${state.stored_observations} · suppressed artifacts: ${state.suppressed_count}`,
      ],
    },
  ];

  if (vitalsRows.length > 0) {
    sections.push({
      title: "Abnormal NEWS2 parameters",
      paragraphs: [
        state.timestamp
          ? `Latest observation ${dateTime(state.timestamp)} UTC · only parameters scoring > 0 shown.`
          : "Only parameters scoring > 0 shown.",
      ],
      table: { headers: ["Parameter", "Reading", "NEWS2 pts", "Band"], rows: vitalsRows },
    });
  }

  if (state.drift.length > 0) {
    sections.push({
      title: "Sustained baseline drift",
      bullets: state.drift.map(
        (d) =>
          `${d.label}: ${d.value} vs baseline ${d.baseline_center.toFixed(1)} (±${d.baseline_spread.toFixed(1)}), robust z=${d.robust_z.toFixed(2)}, sustained ${d.sustained} readings.`,
      ),
    });
  }

  if (clinicalAlerts.length > 0) {
    sections.push({
      title: "Recent clinical alerts",
      table: {
        headers: ["Timestamp (UTC)", "Tier", "NEWS2", "Explanation"],
        rows: clinicalAlerts.map((a) => [
          dateTime(a.timestamp),
          TIER_LABEL[a.tier],
          a.news2 ? String(a.news2.total) : "—",
          a.explanation?.narrative ?? "Threshold / drift triggered.",
        ]),
      },
    });
  }

  if (sensorAlerts.length > 0) {
    sections.push({
      title: "Sensor / device log",
      bullets: sensorAlerts.map(
        (a) =>
          `${dateTime(a.timestamp)} UTC — ${a.alert_kind}: ${a.artifact.reasons.join("; ") || "unreliable signal suppressed."}`,
      ),
    });
  }

  sections.push({
    title: "Other systems within range",
    bullets: [
      normalLabels.length
        ? `${normalLabels.join(", ")} — within expected personal range (not itemized).`
        : "No additional systems to report.",
    ],
  });

  return {
    id: `doc-patient-${p.patient_id}-${generatedAt}`,
    kind: "doctor-patient",
    title: `Clinical Monitoring Report — ${p.display_name}`,
    subtitle: `Post-Discharge Deterioration Assessment (${p.patient_id})`,
    generatedAt,
    authorLabel: clinician,
    filename: `clinical-report-${p.patient_id}.md`,
    disclaimer: state.disclaimer || DEFAULT_DISCLAIMER,
    sections,
    visualContext: { state, alerts, readings, session },
  };
}

export function buildDoctorWardReport(
  rows: PatientRow[],
  session?: Extract<AuthSession, { role: "doctor" }> | null,
): GeneratedReport {
  const generatedAt = nowIso();
  const clinician = session
    ? `${session.clinicianName} (${session.clinicianId})`
    : "Attending Clinician";

  const counts = { URGENT: 0, REVIEW: 0, WATCH: 0, NORMAL: 0 };
  let deviceIssues = 0;
  let awaiting = 0;
  for (const r of rows) {
    if (!r.timestamp) {
      awaiting += 1;
    } else if (r.alert_kind && r.alert_kind !== "CLINICAL") {
      deviceIssues += 1;
    } else if (r.alert_kind === "CLINICAL" && !r.suppressed) {
      counts[r.tier] += 1;
    }
  }
  const totalStored = rows.reduce((s, r) => s + r.stored_observations, 0);
  const totalSuppressed = rows.reduce((s, r) => s + r.suppressed_count, 0);

  return {
    id: `doc-ward-${generatedAt}`,
    kind: "doctor-ward",
    title: "Post-Discharge Ward Census Report",
    subtitle: `${rows.length} monitored patients · Snapshot summary`,
    generatedAt,
    authorLabel: clinician,
    filename: "ward-census-report.md",
    disclaimer: DEFAULT_DISCLAIMER,
    sections: [
      {
        title: "Ward Census Overview",
        bullets: [
          `Urgent: ${counts.URGENT} · Review: ${counts.REVIEW} · Watch: ${counts.WATCH} · Normal: ${counts.NORMAL}`,
          `Device / Sensor issues: ${deviceIssues} · Awaiting first reading: ${awaiting}`,
          `Total FHIR R4 Observations stored: ${totalStored.toLocaleString()} · Suppressed artifacts: ${totalSuppressed}`,
        ],
      },
      {
        title: "Patient Roster",
        table: {
          headers: ["Patient", "Age/Sex", "Tier", "NEWS2", "SpO₂ Scale", "Alerts / Suppressed"],
          rows: rows.map((r) => [
            `${r.display_name} (${r.patient_id})`,
            `${r.age_years}y ${r.sex}`,
            !r.timestamp
              ? "Awaiting"
              : r.alert_kind && r.alert_kind !== "CLINICAL"
                ? r.alert_kind
                : TIER_LABEL[r.tier],
            r.news2_total !== null ? String(r.news2_total) : "—",
            `Scale ${r.spo2_scale}${r.beta_blocked ? " · BB" : ""}`,
            `${r.alert_count} / ${r.suppressed_count}`,
          ]),
        },
      },
    ],
  };
}

export function buildPatientHealthReport(
  state: PatientStatePayload,
  alerts: MonitorResult[],
  readings: Observation[],
  liveOverride?: WatchLiveOverride | null,
): GeneratedReport {
  const p = state.profile;
  const generatedAt = nowIso();
  const obs = liveOverride ?? state.observation;
  const { flagged, normalLabels } = focusedFindings(state, readings, liveOverride, true);

  const targetSpo2 =
    p.spo2_scale === 2
      ? `${p.spo2_target[0]}–${p.spo2_target[1]}% (your personalized target)`
      : "96–100% (standard target)";

  const headline = liveOverride
    ? "Live readings from your connected smartwatch, shown with your recovery history."
    : !state.timestamp
      ? "Your wearable has not sent a reading yet."
      : state.suppressed
        ? "Your last reading had a sensor issue — check that your wearable is snug and charged."
        : flagged.length === 0
          ? "Your vital signs look steady and within your expected recovery range."
          : state.tier === "WATCH"
            ? "We noticed a mild change in your readings. Keep monitoring and follow your care plan."
            : "We noticed a change in your readings. Please contact your care team for a check-in.";

  const attentionBullets = flagged.length
    ? flagged.map((f) => `${f.metricLabel}: ${f.valueText}. ${f.summary}`)
    : ["Nothing needs urgent attention right now."];

  const actionFor = (f: PriorityFinding): string => {
    if (f.metric === "spo2")
      return "Sit upright, take slow deep breaths, and re-check your oxygen. If it stays below your target, call your care team.";
    if (f.metric === "heart_rate")
      return "Rest quietly for 5 minutes and re-check your pulse. Avoid caffeine and exertion until it settles.";
    if (f.metric === "respiratory_rate")
      return "Pause activity, breathe slowly through pursed lips, and re-check. Contact your care team if breathing feels hard.";
    return "Rest, sip fluids, and re-check your temperature. Contact your care team if a fever persists.";
  };

  const nextSteps = flagged.length
    ? flagged.slice(0, 3).map((f) => actionFor(f))
    : [
        "Keep taking your medications exactly as prescribed.",
        "Wear your sensor snugly and keep it charged so readings stay reliable.",
        "Follow your discharge care plan and attend your follow-up appointment.",
      ];

  const recentCheckins = alerts
    .filter((a) => a.alert_kind === "CLINICAL" && a.tier !== "NORMAL")
    .slice(0, 3);

  const sections: ReportSection[] = [
    {
      title: "How you are doing",
      paragraphs: [headline],
      bullets: [
        `Last reading: ${liveOverride ? "live from your smartwatch" : state.timestamp ? `${dateTime(state.timestamp)} UTC` : "waiting for first reading"}`,
        `Your oxygen (SpO₂) target: ${targetSpo2}`,
      ],
    },
    {
      title: "What needs attention",
      bullets: attentionBullets,
    },
    {
      title: "What to do next",
      bullets: nextSteps,
    },
    {
      title: "What is going well",
      bullets: [
        normalLabels.length
          ? `${plainOrganList(normalLabels)} — within your normal range.`
          : "Keep monitoring; your care team is watching your readings.",
      ],
    },
  ];

  if (obs) {
    sections.push({
      title: "Your latest numbers",
      table: {
        headers: ["Vital sign", "Reading", "Note"],
        rows: [
          ["Heart rate", `${fmtMetric(obs.heart_rate)} bpm`, p.beta_blocked ? "adjusted for your heart medication" : "resting pulse"],
          ["Oxygen (SpO₂)", `${fmtMetric(obs.spo2)} %`, `target ${targetSpo2}`],
          ["Breathing rate", `${fmtMetric(obs.respiratory_rate)} /min`, ""],
          ["Temperature", `${fmtMetric(obs.temperature, 1)} °C`, ""],
        ],
      },
    });
  }

  sections.push({
    title: "Get help now if you have",
    bullets: [
      "Severe or worsening breathlessness, or chest pain/pressure.",
      "Confusion, fainting, or blue lips/fingertips.",
      "Oxygen staying below your target, or a fever that will not come down.",
      "If symptoms are severe, call your local emergency number immediately.",
    ],
  });

  sections.push({
    title: "My conditions & medications",
    bullets: [
      `Conditions: ${p.conditions.map((c) => c.display).join(", ") || "none listed"}`,
      `Medications: ${p.medications.map((m) => m.display).join(", ") || "none listed"}`,
    ],
  });

  if (recentCheckins.length > 0) {
    sections.push({
      title: "Recent check-in notices",
      bullets: recentCheckins.map(
        (a) => `${dateTime(a.timestamp)} UTC — ${a.explanation?.narrative ?? "A change in your vitals was noted."}`,
      ),
    });
  }

  return {
    id: `patient-summary-${p.patient_id}-${generatedAt}`,
    kind: "patient-summary",
    title: `My Post-Discharge Health Summary`,
    subtitle: `${p.display_name} · Discharged ${p.discharged_on}`,
    generatedAt,
    authorLabel: `${p.display_name} (Patient Portal)`,
    filename: `health-summary-${p.patient_id}.md`,
    disclaimer:
      "This summary is for personal tracking and care-team communication only — it is not a medical diagnosis. Seek urgent medical care if you feel unwell.",
    sections,
    visualContext: { state, alerts, readings, liveOverride },
  };
}

export function deriveOrganFindings(
  state: PatientStatePayload,
  liveOverride?: WatchLiveOverride | null,
  patientFriendly = false,
): OrganFinding[] {
  const twin = clinicalToTwinPayload(state, liveOverride);
  const a = twin.assessments;
  const obs = liveOverride ?? state.observation;

  const specs: Array<{
    key: "heart_rate" | "spo2" | "respiratory_rate" | "temperature";
    organ: string;
    metricLabel: string;
    unit: string;
    digits: number;
    highMsg: string;
    lowMsg: string;
    okMsg: string;
  }> = [
    {
      key: "heart_rate",
      organ: "Heart & Circulation",
      metricLabel: "Heart Rate",
      unit: "bpm",
      digits: 0,
      highMsg: patientFriendly
        ? "Your heart rate is higher than your normal resting range."
        : "Tachycardic / elevated pulse relative to personal baseline & beta-blocker rule.",
      lowMsg: patientFriendly
        ? "Heart rate is below your normal resting range."
        : "Bradycardic / depressed pulse relative to personal baseline.",
      okMsg: patientFriendly ? "Steady heart rate." : "Within expected personal range.",
    },
    {
      key: "spo2",
      organ: "Lungs & Oxygenation",
      metricLabel: "Blood Oxygen (SpO₂)",
      unit: "%",
      digits: 1,
      highMsg: patientFriendly ? "Oxygen level is above target." : "Above personalized SpO₂ target.",
      lowMsg: patientFriendly
        ? `Your oxygen is low (${fmtMetric(obs?.spo2, 1)}% vs your target ${state.profile.spo2_target[0]}–${state.profile.spo2_target[1]}%).`
        : `Hypoxemic trend below Scale ${state.profile.spo2_scale} target (${state.profile.spo2_target[0]}–${state.profile.spo2_target[1]}%).`,
      okMsg: patientFriendly ? "Oxygen delivery is on target." : "Within personalized SpO₂ target.",
    },
    {
      key: "respiratory_rate",
      organ: "Respiratory Drive",
      metricLabel: "Breathing Rate",
      unit: "br/min",
      digits: 1,
      highMsg: patientFriendly
        ? `Your breathing is faster than usual (${fmtMetric(obs?.respiratory_rate, 1)} breaths/min).`
        : "Tachypnea / elevated respiratory rate (NEWS2 high risk).",
      lowMsg: patientFriendly
        ? "Breathing rate is unusually slow."
        : "Bradypnea / depressed respiratory rate.",
      okMsg: patientFriendly ? "Breathing pace is steady." : "Normal respiratory cadence.",
    },
    {
      key: "temperature",
      organ: "Systemic / Thermal",
      metricLabel: "Body Temperature",
      unit: "°C",
      digits: 2,
      highMsg: patientFriendly
        ? "You have a fever."
        : "Pyrexia / febrile elevation above baseline.",
      lowMsg: patientFriendly
        ? "Body temperature is lower than normal."
        : "Hypothermic drift below baseline.",
      okMsg: patientFriendly ? "Normal body temperature." : "Normothermic.",
    },
  ];

  return specs.map((s) => {
    const item = a[s.key];
    const val = item?.value;
    const expected = item?.expected ?? val ?? 0;
    
    // Status fallback based on patient state tier if assessments were defaulted
    let status = item?.status ?? "normal";
    if (status === "normal" && !liveOverride) {
      if (s.key === "heart_rate" && (val ?? 0) >= 105) status = (val ?? 0) >= 130 ? "anomalous" : "watch";
      if (s.key === "spo2" && val !== null && val !== undefined) {
        const minTarget = state.profile.spo2_scale === 2 ? state.profile.spo2_target[0] : 95;
        if (val < minTarget) status = val < minTarget - 3 ? "anomalous" : "watch";
      }
      if (s.key === "respiratory_rate" && (val ?? 0) >= 22) status = (val ?? 0) >= 25 ? "anomalous" : "watch";
      if (s.key === "temperature" && val !== null && val !== undefined) {
        if (val >= 38.0 || val <= 35.5) status = "anomalous";
        else if (val >= 37.6) status = "watch";
      }
    }

    const summary =
      status === "normal"
        ? s.okMsg
        : (val ?? expected) >= expected
          ? s.highMsg
          : s.lowMsg;
    const base = state.baselines?.[s.key];
    const baselineText = base
      ? `Baseline ${base.center.toFixed(s.digits)} (±${(2 * base.spread).toFixed(s.digits)} ${s.unit})`
      : "Baseline established";
    return {
      organ: s.organ,
      metric: s.key,
      metricLabel: s.metricLabel,
      valueText: val !== undefined && val !== null ? `${fmtMetric(val, s.digits)} ${s.unit}` : "—",
      baselineText,
      status,
      summary,
    };
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TREND_THRESH: Record<MetricKey, number> = {
  heart_rate: 5,
  spo2: 1.5,
  respiratory_rate: 2,
  temperature: 0.3,
};

/** Coarse direction of a metric across the reading window (early third vs late third). */
export function trendLabel(readings: Observation[], metric: MetricKey): string | null {
  const vals = readings
    .map((r) => r[metric])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vals.length < 6) return null;
  const k = Math.max(2, Math.floor(vals.length / 3));
  const early = vals.slice(0, k).reduce((s, v) => s + v, 0) / k;
  const late = vals.slice(-k).reduce((s, v) => s + v, 0) / k;
  const delta = late - early;
  if (Math.abs(delta) < TREND_THRESH[metric]) return "steady";
  return delta > 0 ? "rising" : "falling";
}

export interface PriorityFinding extends OrganFinding {
  trend: string | null;
}

/**
 * Split organ findings into the few that need attention (severe first) and a
 * compact list of the systems that are within range, so reports lead with what
 * matters instead of dumping every normal value.
 */
export function focusedFindings(
  state: PatientStatePayload,
  readings: Observation[],
  liveOverride?: WatchLiveOverride | null,
  patientFriendly = false,
): { flagged: PriorityFinding[]; normalLabels: string[] } {
  const rank = { anomalous: 0, watch: 1, normal: 2 } as const;
  const all = deriveOrganFindings(state, liveOverride, patientFriendly);
  const flagged: PriorityFinding[] = all
    .filter((f) => f.status !== "normal")
    .sort((a, b) => rank[a.status] - rank[b.status])
    .map((f) => ({ ...f, trend: trendLabel(readings, f.metric) }));
  const normalLabels = all.filter((f) => f.status === "normal").map((f) => f.organ);
  return { flagged, normalLabels };
}

function trendPhrase(trend: string | null, metric: MetricKey): string {
  if (!trend || trend === "steady") return "trend steady";
  const worsening =
    (metric === "spo2" && trend === "falling") ||
    (metric !== "spo2" && trend === "rising");
  return `trend ${trend}${worsening ? " (worsening)" : ""}`;
}

const PLAIN_ORGAN: Record<string, string> = {
  "Heart & Circulation": "your heart rate",
  "Lungs & Oxygenation": "your oxygen",
  "Respiratory Drive": "your breathing",
  "Systemic / Thermal": "your temperature",
};

function plainOrganList(organs: string[]): string {
  const plain = organs.map((o) => PLAIN_ORGAN[o] ?? o);
  if (plain.length <= 1) return plain[0] ?? "";
  return plain.slice(0, -1).join(", ") + " and " + plain[plain.length - 1];
}

function buildSvgSparkline(
  readings: Observation[],
  metric: "heart_rate" | "spo2" | "respiratory_rate" | "temperature",
  label: string,
  unit: string,
  color: string,
): string {
  const vals = readings
    .map((r) => r[metric])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vals.length < 2) {
    return `<div class="chart-card"><div class="chart-title">${escapeHtml(label)} (${escapeHtml(unit)})</div><div class="muted">Not enough readings for trend graph</div></div>`;
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const w = 280;
  const h = 74;
  const pts = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * (w - 16) + 8;
      const y = h - 10 - ((v - min) / span) * (h - 20);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const latest = vals[vals.length - 1];
  return `<div class="chart-card">
    <div class="chart-head"><span>${escapeHtml(label)}</span><strong>${latest.toFixed(metric === "temperature" ? 1 : 0)} ${escapeHtml(unit)}</strong></div>
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${escapeHtml(label)} trend">
      <polyline fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" points="${pts}" />
    </svg>
    <div class="chart-range">Min ${min.toFixed(1)} · Max ${max.toFixed(1)} ${escapeHtml(unit)}</div>
  </div>`;
}

/** Open the self-contained report in a new window and trigger the browser print / Save-as-PDF preview.
 *  Must be called synchronously from a user gesture so the popup is not blocked. */
export function printReport(report: GeneratedReport, twinSnapshotDataUrl?: string | null): void {
  const html = reportToHtml(report, twinSnapshotDataUrl);
  const win = window.open("", "_blank", "width=1000,height=800");
  if (!win) {
    window.print();
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  let printed = false;
  const doPrint = () => {
    if (printed) return;
    printed = true;
    win.focus();
    win.print();
  };
  win.onload = () => window.setTimeout(doPrint, 150);
  window.setTimeout(doPrint, 1200);
}

export function reportToHtml(report: GeneratedReport, twinSnapshotDataUrl?: string | null): string {
  const vc = report.visualContext;
  const patientFriendly = report.kind === "patient-summary";
  const focus = vc
    ? focusedFindings(vc.state, vc.readings, vc.liveOverride, patientFriendly)
    : { flagged: [] as PriorityFinding[], normalLabels: [] as string[] };
  const obs = vc ? (vc.liveOverride ?? vc.state.observation) : null;
  const allFindings = vc ? deriveOrganFindings(vc.state, vc.liveOverride, patientFriendly) : [];

  const STD_RANGE: Record<MetricKey, [number, number]> = {
    heart_rate: [60, 100],
    spo2: [95, 100],
    respiratory_rate: [12, 20],
    temperature: [36.1, 37.2],
  };
  const METRIC_UNIT: Record<MetricKey, string> = {
    heart_rate: "bpm",
    spo2: "%",
    respiratory_rate: "br/min",
    temperature: "°C",
  };
  const METRIC_DIGITS: Record<MetricKey, number> = {
    heart_rate: 0,
    spo2: 1,
    respiratory_rate: 1,
    temperature: 1,
  };

  const vitalRows = allFindings
    .map((f) => {
      const val = obs ? obs[f.metric] : null;
      const base = vc?.state.baselines?.[f.metric];
      const [lo, hi] = base
        ? [base.center - 2 * base.spread, base.center + 2 * base.spread]
        : STD_RANGE[f.metric];
      const d = METRIC_DIGITS[f.metric];
      const has = val !== null && val !== undefined;
      const result = has ? val!.toFixed(d) : "—";
      const abn = has && (val! > hi || val! < lo);
      return `<tr><td class="tname">${escapeHtml(f.metricLabel)}</td><td class="colon">:</td><td class="val${abn ? " abn" : ""}">${result} ${escapeHtml(METRIC_UNIT[f.metric])}</td><td class="range">${lo.toFixed(d)} - ${hi.toFixed(d)}</td></tr>`;
    })
    .join("");

  const findingsHtml = vc
    ? `<h2 class="sec">Key Findings</h2>
      ${
        focus.flagged.length
          ? focus.flagged
              .map(
                (f) =>
                  `<p class="finding"><strong>${escapeHtml(f.organ)}</strong> : <span class="val abn">${escapeHtml(f.valueText)}</span> — ${escapeHtml(f.summary)}</p>`,
              )
              .join("")
          : `<p>No physiological system is currently flagged against the personal baseline.</p>`
      }
      ${
        focus.normalLabels.length
          ? `<p class="within">Within range: ${escapeHtml(focus.normalLabels.join(", "))}.</p>`
          : ""
      }`
    : "";

  const chartsHtml =
    vc && vc.readings.length > 1
      ? `<h2 class="sec">Vital Sign Trends</h2><div class="charts-grid">
          ${buildSvgSparkline(vc.readings, "heart_rate", "Heart Rate", "bpm", "#1a3fa0")}
          ${buildSvgSparkline(vc.readings, "spo2", "SpO₂", "%", "#1a3fa0")}
          ${buildSvgSparkline(vc.readings, "respiratory_rate", "Respiratory Rate", "br/min", "#1a3fa0")}
          ${buildSvgSparkline(vc.readings, "temperature", "Temperature", "°C", "#1a3fa0")}
        </div>`
      : "";

  const sectionsHtml = report.sections
    .map((sec) => {
      const ps = (sec.paragraphs ?? []).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
      const bs =
        sec.bullets && sec.bullets.length
          ? `<ul>${sec.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`
          : "";
      const tbl =
        sec.table && sec.table.rows.length
          ? `<table class="cols"><thead><tr>${sec.table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${sec.table.rows
              .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
              .join("")}</tbody></table>`
          : "";
      return `<section><h2 class="sec">${escapeHtml(sec.title)}</h2>${ps}${bs}${tbl}</section>`;
    })
    .join("");

  const notes = report.doctorNotes;
  const notesHtml =
    notes && (notes.assessment || notes.plan || notes.followUp)
      ? `<section><h2 class="sec">Clinician Addendum</h2>
          ${
            notes.editedBy || notes.editedAt
              ? `<p class="muted">Edited by ${escapeHtml(notes.editedBy ?? "clinician")}${notes.editedAt ? ` · ${escapeHtml(dateTime(notes.editedAt))} UTC` : ""}</p>`
              : ""
          }
          ${notes.assessment ? `<p><strong>Assessment:</strong> ${escapeHtml(notes.assessment)}</p>` : ""}
          ${notes.plan ? `<p><strong>Plan:</strong> ${escapeHtml(notes.plan)}</p>` : ""}
          ${notes.followUp ? `<p><strong>Follow-up:</strong> ${escapeHtml(notes.followUp)}</p>` : ""}
        </section>`
      : "";

  const billNo = (() => {
    let h = 0;
    for (const ch of report.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return 10000 + (h % 90000);
  })();
  const gd = new Date(report.generatedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const reportDate = `${pad(gd.getDate())}.${pad(gd.getMonth() + 1)}.${gd.getFullYear()}`;
  const clinician = vc?.session?.clinicianName ?? "VitalTwin Care Team";
  const copyTag = patientFriendly ? "PATIENT" : "CLINICAL";

  const particularsHtml = vc
    ? `<div class="particulars">
        <div class="left">
          <div>B.NO: ${billNo}</div>
          <div>Patients Name: ${escapeHtml(vc.state.profile.display_name)}</div>
          <div>Ref.By: ${escapeHtml(clinician)}</div>
        </div>
        <div class="right">
          <div>Age: ${vc.state.profile.age_years} yrs &nbsp;&nbsp; Sex: ${escapeHtml(vc.state.profile.sex)}</div>
          <div>Date: ${reportDate}</div>
          <div>Discharged: ${escapeHtml(vc.state.profile.discharged_on)}</div>
          <div>Copy: ${copyTag}</div>
        </div>
      </div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(report.title)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; margin: 0; padding: 16px; font-size: 12.5px; line-height: 1.5; }
  .sheet { max-width: 820px; margin: 0 auto; padding: 10px 26px 26px; }
  .lab-head { text-align: center; color: #1a3fa0; border-top: 2px solid #1a3fa0; border-bottom: 2px solid #1a3fa0; padding: 8px 6px 7px; }
  .lab-name { font-family: 'Times New Roman', serif; font-weight: bold; font-size: 22px; letter-spacing: .5px; }
  .lab-centre { font-family: 'Times New Roman', serif; font-weight: bold; font-size: 18px; letter-spacing: .4px; }
  .lab-addr { font-weight: bold; font-size: 11px; margin-top: 3px; }
  .lab-services { font-family: 'Times New Roman', serif; font-style: italic; font-weight: bold; font-size: 11.5px; margin-top: 2px; }
  .lab-tag { font-family: 'Times New Roman', serif; font-style: italic; font-weight: bold; font-size: 13.5px; margin-top: 5px; }
  .report-title { text-align: center; font-weight: bold; font-size: 14px; margin: 12px 0 2px; text-transform: uppercase; letter-spacing: .4px; }
  .report-sub { text-align: center; font-size: 11px; color: #333; margin-bottom: 4px; }
  .revised { text-align: center; font-size: 10.5px; color: #1a3fa0; font-weight: bold; margin: 2px 0 6px; }
  .particulars { display: flex; justify-content: space-between; gap: 20px; margin: 16px 0 4px; }
  .particulars .left div, .particulars .right div { margin: 4px 0; }
  .particulars .right { min-width: 40%; }
  h2.sec { font-size: 12.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.2px; text-decoration: underline; text-underline-offset: 4px; margin: 20px 0 8px; }
  table.cols { width: 100%; border-collapse: collapse; }
  table.cols th, table.cols td { border: none; padding: 7px 10px 7px 0; text-align: left; vertical-align: top; }
  table.cols th { font-weight: normal; }
  td.tname, th.tname { width: 34%; }
  td.colon, th.colon { width: 2%; padding-right: 4px; }
  td.val, th.val { width: 30%; font-family: 'Courier New', monospace; }
  td.range, th.range { width: 34%; }
  .val.abn { font-weight: bold; }
  p.finding { margin: 6px 0; }
  p.finding .val { font-family: 'Courier New', monospace; }
  .within, .muted { color: #333; font-size: 11.5px; }
  section p { margin: 6px 0; }
  section ul { margin: 6px 0; padding-left: 22px; }
  section li { margin: 3px 0; }
  .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .chart-card { padding: 4px 6px; }
  .chart-head { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
  .chart-title, .chart-range { font-size: 11px; color: #333; }
  .twin-snap { text-align: center; margin: 14px 0; }
  .twin-snap img { max-height: 250px; max-width: 100%; }
  .sig { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 36px; }
  .sig .left, .sig .right { text-align: left; }
  .sig .role { margin-top: 2px; }
  .closing { text-align: center; margin-top: 20px; }
  .closing div { margin: 3px 0; }
  .fine { text-align: center; font-style: italic; font-size: 10.5px; color: #333; margin-top: 14px; }
  .motto { text-align: center; color: #c00; font-family: 'Segoe Script', 'Brush Script MT', 'Comic Sans MS', cursive; font-style: italic; font-weight: bold; font-size: 19px; margin-top: 26px; }
  @media print { body { padding: 0; } .sheet { max-width: none; padding: 0 8mm; } }
</style>
</head>
<body>
  <article class="sheet">
    <div class="lab-head">
      <div class="lab-name">VITALTWIN LAB</div>
      <div class="lab-centre">VITALTWIN DIGITAL HEALTH CENTRE</div>
      <div class="lab-addr">Post-Discharge Remote Monitoring · Clinical Decision Support · Synthetic Data</div>
      <div class="lab-services">Continuous Wearable Vitals, NEWS2 Scoring, Personal Baseline Drift, FHIR R4 Observations</div>
      <div class="lab-tag">Complete Post-Discharge Monitoring Done here.</div>
    </div>
    <div class="report-title">${escapeHtml(report.title)}</div>
    <div class="report-sub">${escapeHtml(report.subtitle)}</div>
    ${
      notes?.editedBy || notes?.editedAt
        ? `<div class="revised">Revised by ${escapeHtml(notes.editedBy ?? "clinician")}${notes.editedAt ? ` · ${escapeHtml(dateTime(notes.editedAt))} UTC` : ""}</div>`
        : ""
    }
    ${particularsHtml}
    ${
      vc
        ? `<h2 class="sec">Vital Signs</h2>
          <table class="cols"><thead><tr><th class="tname">Test Name</th><th class="colon"></th><th class="val">Values</th><th class="range">Normal Range</th></tr></thead><tbody>${vitalRows}</tbody></table>`
        : ""
    }
    ${findingsHtml}
    ${twinSnapshotDataUrl ? `<div class="twin-snap"><img src="${twinSnapshotDataUrl}" alt="3D Digital Twin showing highlighted organs" /></div>` : ""}
    ${chartsHtml}
    ${sectionsHtml}
    ${notesHtml}
    <div class="sig">
      <div class="left">
        <svg width="90" height="34" viewBox="0 0 90 34" aria-hidden="true"><path d="M6 26 C 14 6, 20 6, 24 20 S 34 30, 40 14 S 52 4, 56 18 S 70 26, 84 10" fill="none" stroke="#223" stroke-width="1.6" stroke-linecap="round"/></svg>
        <div class="role">Lab Incharge</div>
      </div>
      <div class="right">
        <div>${escapeHtml(clinician)}</div>
        <div class="role">Consultant, Remote Monitoring</div>
      </div>
    </div>
    <div class="closing">
      <div>Fully Computerised Monitoring</div>
      <div>Get Well Soon</div>
    </div>
    <div class="fine">${escapeHtml(report.disclaimer)}</div>
    <div class="motto">Care is Our Concern</div>
  </article>
</body>
</html>`;
}
