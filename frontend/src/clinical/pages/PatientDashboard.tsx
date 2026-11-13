import { useEffect, useState } from "react";
import { ClinicalTwin3D, type WatchLiveOverride } from "../ClinicalTwin3D";
import { SmartwatchSimulator } from "../SmartwatchSimulator";
import { clinicalApi, LOINC, VITAL_RANGE, vitalStatus } from "../api";
import { usePatient } from "../hooks";
import { SavedReportsPanel } from "../SavedReports";
import { buildPatientHealthReport, reportToHtml } from "../reportGenerator";
import type { AuthSession } from "../auth";
import { ReportEmailStatus, useReportEmail } from "../reportEmail";
import type { FhirObservation, MonitorResult } from "../types";
import { VitalsCharts } from "../VitalsCharts";
import { Empty, Panel, dateTime } from "../ui";

type Tone = "ok" | "watch" | "review" | "urgent" | "sensor";

const PATIENT_VITALS = ["heart_rate", "spo2", "respiratory_rate", "temperature"] as const;
type PatientMetric = (typeof PATIENT_VITALS)[number];

type BaselineMap = Record<string, { center: number; spread: number }>;

const CHECK_IN_LABEL: Record<string, string> = {
  NORMAL: "Check-in",
  WATCH: "Small change",
  REVIEW: "Noticeable change",
  URGENT: "Important change",
};

/** Smallest change from a personal baseline that is worth flagging, per vital. */
const USUAL_TOLERANCE: Record<PatientMetric, number> = {
  heart_rate: 8,
  spo2: 2,
  respiratory_rate: 3,
  temperature: 0.4,
};

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function daysSince(isoDate: string | null | undefined): number | null {
  if (!isoDate) return null;
  const then = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(then.getTime())) return null;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.floor((today - then.getTime()) / 86_400_000);
  return days >= 0 ? days : null;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function patientStatusCopy(
  hasTimestamp: boolean,
  suppressed: boolean,
  tier: string,
  alertKind: string | null,
): { badge: string; tone: Tone; message: string; steps: string[] } {
  if (!hasTimestamp) {
    return {
      badge: "Waiting for your first reading",
      tone: "sensor",
      message:
        "Your smartwatch has not sent a reading yet. Start your monitor below and your vitals will appear here automatically.",
      steps: [
        "Put the smartwatch on and check the strap is snug.",
        "Select Start live readings, or send a reading from the watch panel.",
        "Keep the watch charged — readings update every minute.",
      ],
    };
  }
  if (suppressed || (alertKind && alertKind !== "CLINICAL")) {
    return {
      badge: "Check your wearable sensor",
      tone: "sensor",
      message:
        "Your last reading looked noisy or disconnected, so it was not used for your health score. This is usually a loose sensor rather than a change in your health.",
      steps: [
        "Make sure the watch sits flat on your wrist and the strap is snug.",
        "Sit still for a minute, then send a reading again.",
        "If the problem continues, charge the watch and contact your care team.",
      ],
    };
  }
  if (tier === "NORMAL") {
    return {
      badge: "Your recovery looks steady",
      tone: "ok",
      message:
        "Your recent vital signs are within your personal post-discharge target range. Keep following your daily care plan.",
      steps: [
        "Keep wearing the watch during the day and while you sleep.",
        "Take your medications as prescribed and stay hydrated.",
        "Keep your follow-up appointment with your care team.",
      ],
    };
  }
  if (tier === "WATCH") {
    return {
      badge: "Keep an eye on your readings",
      tone: "watch",
      message:
        "A mild shift was noticed compared with your usual readings. This is not an emergency, but it is worth watching.",
      steps: [
        "Rest for 15 minutes, drink some water, and send a new reading.",
        "Check that the sensor is snug and the watch is charged.",
        "If the change persists for a few hours, message your care team.",
      ],
    };
  }
  if (tier === "REVIEW") {
    return {
      badge: "It is time to check in with your care team",
      tone: "review",
      message:
        "Your readings show a moderate change from your personal baseline. Your care team should look at this today.",
      steps: [
        "Contact your post-discharge nurse or doctor today.",
        "Rest and avoid strenuous activity until you have spoken to them.",
        "Send another reading so they can see the latest numbers.",
      ],
    };
  }
  return {
    badge: "Please contact your care team promptly",
    tone: "urgent",
    message:
      "Your latest vital signs show a significant change. Reach out to your care team now, or seek urgent medical attention if you feel unwell.",
    steps: [
      "Call your care team or your local urgent care line now.",
      "Do not drive yourself if you feel faint, breathless, or unwell.",
      "Keep the watch on so your team can see your latest readings.",
    ],
  };
}

function describeChange(a: MonitorResult, baselines: BaselineMap): string {
  const readings = a.explanation?.readings ?? [];
  const notable = readings.filter((r) => (r.news2_points ?? 0) > 0 || r.drift);
  if (notable.length === 0) {
    return a.explanation?.narrative ?? "A change from your usual vital range was detected.";
  }
  const parts = notable.slice(0, 3).map((r) => {
    const digits = r.metric === "temperature" ? 1 : 0;
    const value = typeof r.value === "number" ? r.value.toFixed(digits) : String(r.value ?? "—");
    const base = baselines[r.metric];
    const usual = base ? ` (your usual ${base.center.toFixed(digits)} ${r.unit})` : "";
    return `${r.label.toLowerCase()} was ${value} ${r.unit}${usual}`;
  });
  return `Compared with your usual readings, ${joinList(parts)}.`;
}

function vitalTile(
  metric: PatientMetric,
  value: number | null,
  untrusted: string[],
  baselines: BaselineMap,
): { tone: Tone | "absent" | "high" | "low"; chip: string; note: string } {
  const meta = LOINC[metric];
  const digits = metric === "temperature" ? 1 : 0;
  if (untrusted.includes(metric)) {
    return {
      tone: "sensor",
      chip: "Check sensor",
      note: "This reading looked noisy, so it was skipped. Check that your watch is snug.",
    };
  }
  if (value === null) {
    return {
      tone: "absent",
      chip: "No reading",
      note: "Waiting for the next reading from your smartwatch.",
    };
  }
  const base = baselines[metric];
  const status = vitalStatus(metric, value);
  const range = VITAL_RANGE[metric];
  const rangeText = range ? `${range[0]}–${range[1]} ${meta.unit}` : "";
  if (base) {
    const margin = Math.max(base.spread, USUAL_TOLERANCE[metric]);
    const usual = `${base.center.toFixed(digits)} ${meta.unit}`;
    if (value > base.center + margin) {
      return { tone: "watch", chip: "Above your usual", note: `You usually sit around ${usual}.` };
    }
    if (value < base.center - margin) {
      return { tone: "watch", chip: "Below your usual", note: `You usually sit around ${usual}.` };
    }
  }
  if (status.tone === "high") {
    return { tone: "high", chip: "Above normal", note: `Typical resting range is ${rangeText}.` };
  }
  if (status.tone === "low") {
    return { tone: "low", chip: "Below normal", note: `Typical resting range is ${rangeText}.` };
  }
  if (base) {
    return {
      tone: "ok",
      chip: "Near your usual",
      note: `In line with your usual ${base.center.toFixed(digits)} ${meta.unit}.`,
    };
  }
  return { tone: "ok", chip: "Normal range", note: `Typical resting range is ${rangeText}.` };
}

export function PatientDashboard({ patientId, session }: {
  patientId: string;
  session: Extract<AuthSession, { role: "patient" }>;
}) {
  const { state, alerts, readings, connection, error } = usePatient(patientId);
  const reportEmail = useReportEmail();
  const [savedRefresh, setSavedRefresh] = useState(0);
  const [streamingBusy, setStreamingBusy] = useState(false);
  const [fhirEntries, setFhirEntries] = useState<FhirObservation[]>([]);
  const [hapiHealthy, setHapiHealthy] = useState<boolean | null>(null);
  const [watchConnected, setWatchConnected] = useState(true);
  const [activeTab, setActiveTab] = useState<"graphs" | "body3d">("graphs");
  const [watchValues, setWatchValues] = useState<WatchLiveOverride>({
    heart_rate: 74,
    spo2: 97,
    respiratory_rate: 16,
    temperature: 36.7,
  });

  useEffect(() => {
    if (state?.observation && !watchConnected) {
      setWatchValues({
        heart_rate: Math.round(state.observation.heart_rate ?? 74),
        spo2: Math.round(state.observation.spo2 ?? 97),
        respiratory_rate: Math.round(state.observation.respiratory_rate ?? 16),
        temperature: Number((state.observation.temperature ?? 36.7).toFixed(1)),
      });
    }
  }, [state?.observation, watchConnected]);

  useEffect(() => {
    let cancelled = false;
    clinicalApi
      .hapiHealth()
      .then((h) => {
        if (!cancelled) setHapiHealthy(h.healthy);
      })
      .catch(() => {
        if (!cancelled) setHapiHealthy(false);
      });
    clinicalApi
      .hapiObservations(patientId, undefined, 8)
      .then((res) => {
        if (!cancelled) setFhirEntries(res.entries ?? []);
      })
      .catch(() => {
        if (!cancelled) setFhirEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, state?.stored_observations]);

  const startMyStream = async () => {
    setStreamingBusy(true);
    try {
      await clinicalApi.replayStart([patientId]);
    } finally {
      setStreamingBusy(false);
    }
  };

  const focusWatch = () => {
    setActiveTab("graphs");
    window.requestAnimationFrame(() => {
      document.getElementById("my-watch")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  if (error && !state) {
    return (
      <Panel className="error">
        <strong>Could not load your health record.</strong> {error}
      </Panel>
    );
  }
  if (!state) return <div className="skeleton">Loading your dashboard…</div>;

  const p = state.profile;
  const baselines = state.baselines ?? {};
  const untrusted = state.artifact?.untrusted_metrics ?? [];
  const hasBp = readings.some((r) => r.systolic_bp !== null && r.systolic_bp !== undefined);
  const status = patientStatusCopy(
    Boolean(state.timestamp),
    state.suppressed,
    state.tier,
    state.alert_kind,
  );
  const firstName = p.display_name.trim().split(/\s+/)[0] || p.display_name;
  const dayNumber = daysSince(p.discharged_on);

  const checkIns = alerts
    .filter((a) => a.alert_kind === "CLINICAL" && a.tier !== "NORMAL")
    .slice(0, 4);
  const deviceNotices = alerts.filter((a) => a.alert_kind !== "CLINICAL").slice(0, 6);

  const handleGenerate = () => {
    const rep = buildPatientHealthReport(state, alerts, readings, watchConnected ? watchValues : null);
    reportEmail.generate(rep, session);
    clinicalApi
      .storeReport({ patient_id: patientId, title: rep.title, html: reportToHtml(rep) })
      .then(() => setSavedRefresh((v) => v + 1))
      .catch(() => {});
  };

  return (
    <div className="col patient-dash">
      <section className={`patient-hero patient-hero--${status.tone}`} aria-labelledby="patient-hero-title">
        <div className="patient-hero__top">
          <div className="patient-hero__intro">
            <p className="patient-hero__eyebrow">
              {greeting()}, {firstName}
            </p>
            <h1 className="patient-hero__title" id="patient-hero-title">
              {status.badge}
            </h1>
            <p className="patient-hero__msg">{status.message}</p>
            <p className="patient-hero__meta">
              {p.age_years} years · {p.sex}
              {dayNumber !== null ? ` · Day ${dayNumber + 1} of recovery` : ""}
              {state.timestamp ? ` · Last reading ${dateTime(state.timestamp)} UTC` : " · No readings yet"}
            </p>
          </div>
          <div className="patient-hero__side">
            <span className={`pill pill--${connection === "live" ? "live" : "off"}`} role="status">
              <span className="pill__dot" aria-hidden />
              {connection === "live" ? "Monitor connected" : "Reconnecting"}
            </span>
            <div className="patient-hero__actions">
              {!state.timestamp ? (
                <button className="btn btn--primary" onClick={startMyStream} disabled={streamingBusy}>
                  {streamingBusy ? "Starting…" : "Start live readings"}
                </button>
              ) : (
                <button className="btn btn--primary" onClick={focusWatch}>
                  Open my smartwatch
                </button>
              )}
              <button className="btn" onClick={handleGenerate} disabled={reportEmail.status.sending}>
                {reportEmail.status.sending ? "Preparing report…" : "My health report"}
              </button>
            </div>
          </div>
        </div>
        <div className="patient-steps">
          <h2 className="patient-steps__title">What to do now</h2>
          <ol className="patient-steps__list">
            {status.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </section>

      <ReportEmailStatus status={reportEmail.status} />

      <section className="patient-section" aria-labelledby="vitals-heading">
        <div className="patient-section__head">
          <h2 className="patient-section__title" id="vitals-heading">
            Your vitals right now
          </h2>
          <p className="patient-section__hint">
            {state.timestamp
              ? `Updated ${dateTime(state.timestamp)} UTC · compared with your personal resting baseline`
              : "Waiting for your first smartwatch reading"}
          </p>
        </div>
        <div className="vitals-now">
          {PATIENT_VITALS.map((metric) => {
            const meta = LOINC[metric];
            const value = state.observation ? state.observation[metric] : null;
            const tile = vitalTile(metric, value, untrusted, baselines);
            return (
              <article className={`vital-tile vital-tile--${tile.tone}`} key={metric}>
                <div className="vital-tile__label">{meta.label}</div>
                <div className="vital-tile__value">
                  {value === null ? "—" : value.toFixed(metric === "temperature" ? 1 : 0)}
                  <span className="vital-tile__unit">{meta.unit}</span>
                </div>
                <span className="vital-tile__chip">{tile.chip}</span>
                <p className="vital-tile__note">{tile.note}</p>
              </article>
            );
          })}
        </div>
        <div className="patient-facts">
          <div className="patient-fact">
            <span className="patient-fact__label">Oxygen target</span>
            <span className="patient-fact__value">
              {p.spo2_scale === 2 ? `${p.spo2_target[0]}–${p.spo2_target[1]}%` : "96–100%"}
            </span>
            <span className="patient-fact__note">
              {p.spo2_scale === 2 ? "Set for your breathing condition" : "Standard adult target"}
            </span>
          </div>
          <div className="patient-fact">
            <span className="patient-fact__label">Heart-rate alerts</span>
            <span className="patient-fact__value">
              {p.beta_blocked ? `+${p.pulse_correction_bpm} bpm` : "Standard"}
            </span>
            <span className="patient-fact__note">
              {p.beta_blocked ? "Adjusted for your heart medication" : "No medication adjustment"}
            </span>
          </div>
          <div className="patient-fact">
            <span className="patient-fact__label">Readings tracked</span>
            <span className="patient-fact__value">{readings.length}</span>
            <span className="patient-fact__note">
              {state.baseline_ready ? "Personal baseline active" : "Still learning your baseline"}
              {state.suppressed_count > 0 ? ` · ${state.suppressed_count} noisy readings filtered` : ""}
            </span>
          </div>
        </div>
      </section>

      <div className="segmented" role="tablist" aria-label="Dashboard views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "graphs"}
          className={`segmented__item${activeTab === "graphs" ? " segmented__item--active" : ""}`}
          onClick={() => setActiveTab("graphs")}
        >
          Watch &amp; trends
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "body3d"}
          className={`segmented__item${activeTab === "body3d" ? " segmented__item--active" : ""}`}
          onClick={() => setActiveTab("body3d")}
        >
          3D body view
        </button>
      </div>

      {activeTab === "body3d" ? (
        <Panel
          title="Your 3D body view"
          hint="A live model of your organs driven by your smartwatch readings — amber and red show stressed areas"
          action={
            <button className="btn btn--small" onClick={() => setActiveTab("graphs")}>
              ← Back to watch &amp; trends
            </button>
          }
        >
          <ClinicalTwin3D
            state={state}
            liveOverride={watchConnected ? watchValues : null}
            height="540px"
          />
        </Panel>
      ) : (
        <>
          <div id="my-watch" className="scroll-anchor">
            <Panel
              title="Your smartwatch"
              hint="Change the numbers or pick a scenario, then send a reading"
            >
              <SmartwatchSimulator
                patientId={patientId}
                state={state}
                connected={watchConnected}
                onToggleConnect={() => setWatchConnected((v) => !v)}
                values={watchValues}
                onChangeValues={setWatchValues}
              />
            </Panel>
          </div>

          <Panel
            title="Your vital trends"
            hint={`${readings.length} readings · the shaded band is your personal resting baseline`}
          >
            {readings.length === 0 ? (
              <Empty>
                No trend history yet. Send a reading from the watch above, or select Start live
                readings to plot your graphs.
              </Empty>
            ) : (
              <VitalsCharts
                readings={readings}
                baselines={baselines}
                untrustedMetrics={untrusted}
                includeBp={hasBp}
              />
            )}
          </Panel>

          <div className="grid grid--sidebar">
            <div className="col">
              <Panel title="Recent check-ins" hint="Plain-language notes when something changed">
                {checkIns.length === 0 ? (
                  <Empty>Nothing to flag — your recent readings look steady.</Empty>
                ) : (
                  <div className="patient-checkins">
                    {checkIns.map((a) => (
                      <article
                        className={`patient-checkin patient-checkin--${a.tier.toLowerCase()}`}
                        key={`${a.timestamp}-${a.tier}`}
                      >
                        <div className="patient-checkin__head">
                          <span className="patient-checkin__tier">
                            {CHECK_IN_LABEL[a.tier] ?? a.tier}
                          </span>
                          <span className="patient-checkin__time">{dateTime(a.timestamp)} UTC</span>
                        </div>
                        <p className="patient-checkin__body">{describeChange(a, baselines)}</p>
                      </article>
                    ))}
                  </div>
                )}
              </Panel>
            </div>

            <div className="col">
              <Panel title="Your care plan">
                <div className="col" style={{ gap: 14 }}>
                  <div>
                    <h3 className="patient-subhead">Conditions</h3>
                    {p.conditions.length === 0 ? (
                      <p className="patient-note muted">None listed</p>
                    ) : (
                      <ul className="patient-list">
                        {p.conditions.map((c) => (
                          <li key={c.code}>{c.display.replace(/\s*\(disorder\)$/i, "")}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <h3 className="patient-subhead">Medications</h3>
                    {p.medications.length === 0 ? (
                      <p className="patient-note muted">None listed</p>
                    ) : (
                      <ul className="patient-list">
                        {p.medications.map((m) => (
                          <li key={m.code}>{m.display}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {p.notes && (
                    <div>
                      <h3 className="patient-subhead">Notes from your care team</h3>
                      <p className="patient-note">
                        {p.notes.replace(/^Synthea bundle \S+ \(population seed \d+\)\.\s*/i, "")}
                      </p>
                    </div>
                  )}
                </div>
              </Panel>

              <Panel title="Wearable reminders" hint="Sensor fit and connection">
                {deviceNotices.length === 0 ? (
                  <Empty>Your wearable connection looks good.</Empty>
                ) : (
                  <div className="patient-checkins">
                    {deviceNotices.map((a) => (
                      <article className="patient-checkin patient-checkin--sensor" key={`${a.timestamp}-dev`}>
                        <div className="patient-checkin__head">
                          <span className="patient-checkin__tier">
                            {CHECK_IN_LABEL[a.tier] ?? "Sensor check"}
                          </span>
                          <span className="patient-checkin__time">{dateTime(a.timestamp)} UTC</span>
                        </div>
                        <p className="patient-checkin__body">
                          {a.artifact.reasons[0] ?? "Please check that your wearable sensor is snug."}
                        </p>
                      </article>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel
                title="Your health records"
                hint={`${state.stored_observations} readings stored · FHIR ${hapiHealthy ? "connected" : "offline"}`}
              >
                {fhirEntries.length > 0 ? (
                  <div className="record-list">
                    {fhirEntries.slice(0, 5).map((obs, idx) => {
                      const name =
                        obs.code?.text ?? obs.code?.coding?.[0]?.display ?? "Observation";
                      const value = obs.valueQuantity
                        ? `${obs.valueQuantity.value} ${obs.valueQuantity.unit ?? ""}`.trim()
                        : "missing";
                      return (
                        <div className="record-row" key={obs.id ?? idx}>
                          <span className="record-row__name">{name}</span>
                          <span className="record-row__value">{value}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="patient-note muted">
                    {hapiHealthy === false
                      ? "The health-records server is offline. Your readings are still tracked live in your monitor."
                      : "No health records stored for your record yet."}
                  </p>
                )}
              </Panel>
            </div>
          </div>
        </>
      )}

      <SavedReportsPanel patientId={patientId} refreshToken={savedRefresh} />
    </div>
  );
}
