import { useEffect, useState } from "react";
import type { AuthSession } from "../auth";
import { AlertCard } from "../AlertCard";
import { ClinicalTwin3D } from "../ClinicalTwin3D";
import { usePatient } from "../hooks";
import { ReportModal } from "../ReportModal";
import { SavedReportsPanel } from "../SavedReports";
import { buildDoctorPatientReport, reportToHtml, type GeneratedReport } from "../reportGenerator";
import { clinicalApi } from "../api";
import {
  DriftPanel,
  News2Breakdown,
  ProfilePanel,
  SensorPanel,
  VitalsStrip,
} from "../PatientPanels";
import { VitalsCharts } from "../VitalsCharts";
import { Empty, Panel, SCENARIO_LABEL, Score, TierBadge, dateTime } from "../ui";

type AlertFilter = "clinical" | "device" | "all";

export function PatientPage({
  patientId,
  session,
  onBack,
  onOpenFhir,
}: {
  patientId: string;
  session: Extract<AuthSession, { role: "doctor" }>;
  onBack: () => void;
  onOpenFhir: (id: string) => void;
}) {
  const { state, alerts, readings, connection, error } = usePatient(patientId);
  const [alertFilter, setAlertFilter] = useState<AlertFilter>("clinical");
  const [report, setReport] = useState<GeneratedReport | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [savedRefresh, setSavedRefresh] = useState(0);

  useEffect(() => {
    setAlertFilter("clinical");
  }, [patientId]);

  if (error && !state) {
    return (
      <Panel className="error">
        <strong>Could not load this patient.</strong> {error}
        <div style={{ marginTop: 10 }}>
          <button className="btn btn--small" onClick={onBack}>
            Back to ward
          </button>
        </div>
      </Panel>
    );
  }
  if (!state) return <div className="skeleton">Loading patient…</div>;

  const profile = state.profile;
  const untrusted = state.artifact?.untrusted_metrics ?? [];
  const hasBp = readings.some((r) => r.systolic_bp !== null && r.systolic_bp !== undefined);
  const clinicalAlerts = alerts.filter((a) => a.alert_kind === "CLINICAL");
  const deviceAlerts = alerts.filter((a) => a.alert_kind !== "CLINICAL");
  const filteredAlerts = alertFilter === "clinical"
    ? clinicalAlerts
    : alertFilter === "device"
      ? deviceAlerts
      : alerts;

  const headTone =
    state.alert_kind && state.alert_kind !== "CLINICAL"
      ? "sensor"
      : state.timestamp
        ? state.tier.toLowerCase()
        : "pending";

  return (
    <div className="col">
      <section className={`patient-head patient-head--${headTone}`}>
        <div className="patient-head__identity">
          <button className="btn btn--small" onClick={onBack}>
            ← Ward
          </button>
          <div>
            <h1 className="section-title">{profile.display_name}</h1>
            <p className="lede">
              {profile.age_years} years · {profile.sex} · discharged {profile.discharged_on} ·{" "}
              {SCENARIO_LABEL[profile.scenario] ?? profile.scenario} ·{" "}
              <span className="code">{profile.patient_id}</span>
            </p>
          </div>
        </div>

        <div className="patient-head__actions">
          <button
            className="btn btn--small btn--primary"
            onClick={() => {
              const generated = buildDoctorPatientReport(state, alerts, readings, session);
              setReport(generated);
              setReportOpen(true);
              clinicalApi.storeReport({ patient_id: patientId, title: generated.title, html: reportToHtml(generated) })
                .then(() => setSavedRefresh((value) => value + 1))
                .catch(() => {});
            }}
          >
            Generate Clinical Report
          </button>
          {report && (
            <button className="btn btn--small" onClick={() => setReportOpen(true)}>
              Review last report
            </button>
          )}
          <button className="btn btn--small" onClick={() => onOpenFhir(patientId)}>
            Stored FHIR
          </button>
        </div>

        <div className="patient-head__stats">
          <div className="patient-stat">
            <span className="patient-stat__label">Current status</span>
            {state.timestamp ? (
              <TierBadge tier={state.tier} kind={state.alert_kind} large />
            ) : (
              <span className="pill">Awaiting first reading</span>
            )}
          </div>
          <div className="patient-stat">
            <span className="patient-stat__label">NEWS2</span>
            <span className="patient-stat__value">
              <Score value={state.news2?.total ?? null} big />
              <span className="small muted">{state.news2?.risk_level ?? "not scored"}</span>
            </span>
          </div>
          <div className="patient-stat">
            <span className="patient-stat__label">Stream</span>
            <span className={`pill pill--${connection === "live" ? "live" : "off"}`}>
              <span className="pill__dot" aria-hidden />
              {connection === "live" ? "Live" : connection === "offline" ? "Reconnecting" : "Connecting"}
            </span>
          </div>
          <div className="patient-stat patient-stat--stored">
            <span className="patient-stat__label">FHIR observations</span>
            <span className="patient-stat__value">
              <strong>{state.stored_observations.toLocaleString()}</strong>
              <span className="small muted">LOINC-coded</span>
            </span>
          </div>
        </div>
      </section>

      {error && (
        <div className="notice notice--warn" role="status">
          Latest refresh failed: {error}. Displayed data may be stale.
        </div>
      )}

      {state.suppressed && (
        <div className="notice">
          <strong>Clinical scoring withheld — unreliable device signal.</strong> The
          device needs attention. Suppression does not establish that the patient is
          stable or rule out deterioration.
        </div>
      )}

      <div className="patient-top">
        <div className="col patient-top__left">
          <Panel
            title="Latest vitals"
            hint={state.timestamp ? `${dateTime(state.timestamp)} UTC` : "no reading yet"}
          >
            <VitalsStrip observation={state.observation} untrusted={untrusted} />
            <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
              A missing mandated vital is recorded as{" "}
              <span className="code">dataAbsentReason</span>, never as a zero. Untrusted
              channels stay visible but are withheld from scoring.
            </p>
          </Panel>

          <Panel
            title="Why this tier"
            hint={state.explanation ? "rule-based explanation of the latest reading" : "no scored reading yet"}
          >
            {state.explanation ? (
              <div className="explain">
                <p className="explain__narrative">{state.explanation.narrative}</p>
                {state.explanation.readings.length > 0 && (
                  <ul className="explain__list">
                    {state.explanation.readings.map((reading) => (
                      <li key={`${reading.metric}-${reading.band}`} className="explain__row">
                        <span className="explain__metric">{reading.label}</span>
                        <span className="explain__value">
                          {reading.value ?? "—"}
                          {reading.unit && <small> {reading.unit}</small>}
                        </span>
                        <span className="explain__band">{reading.band}</span>
                        <span
                          className={`explain__points${reading.news2_points > 0 ? " explain__points--on" : ""}`}
                          title={`NEWS2 points: ${reading.news2_points}`}
                        >
                          {reading.news2_points}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {state.explanation.profile_facts.length > 0 && (
                  <p className="explain__facts">
                    <strong>Applied to this patient:</strong>{" "}
                    {state.explanation.profile_facts.join(" · ")}
                  </p>
                )}
              </div>
            ) : (
              <Empty>
                {state.suppressed
                  ? "Clinical scoring was withheld for the latest reading because the device signal was unreliable."
                  : "No scored reading yet — connect the wearable or start a replay from the ward."}
              </Empty>
            )}
          </Panel>
        </div>

        <Panel
          title="3D Digital Twin"
          hint="live anatomy driven by this patient's vitals & alert tier"
          className="patient-top__twin"
        >
          <ClinicalTwin3D state={state} height="480px" />
        </Panel>
      </div>

      <div className="grid grid--sidebar">
        <div className="col">
          <Panel
            title="Vital trends"
            hint={`${readings.length} available readings · shaded band: rolling baseline ±3 spreads`}
          >
            {readings.length === 0 ? (
              <Empty>No trend history available yet. If replay has not started, start it from the ward.</Empty>
            ) : (
              <VitalsCharts
                readings={readings}
                baselines={state.baselines ?? {}}
                untrustedMetrics={untrusted}
                includeBp={hasBp}
              />
            )}
            <p className="small muted" style={{ marginTop: 10 }}>
              Raw reported readings may include artifacts. The signal warning applies
              to the latest assessment; the shaded baseline is not a clinical safety range.
            </p>
          </Panel>

          <News2Breakdown
            news2={state.news2}
            profile={profile}
            observation={state.observation}
            suppressed={state.suppressed}
          />

          <DriftPanel
            drift={state.drift}
            baselines={state.baselines ?? {}}
            ready={state.baseline_ready}
          />

          <Panel
            title="Alert history"
            hint={`${clinicalAlerts.length} clinical · ${deviceAlerts.length} device · loaded history`}
            action={
              <label className="row row--tight small" style={{ alignItems: "center" }}>
                Show
                <select
                  className="btn btn--small"
                  aria-label="Filter patient alerts"
                  value={alertFilter}
                  onChange={(event) => setAlertFilter(event.target.value as AlertFilter)}
                >
                  <option value="clinical">Clinical ({clinicalAlerts.length})</option>
                  <option value="device">Device ({deviceAlerts.length})</option>
                  <option value="all">All ({alerts.length})</option>
                </select>
              </label>
            }
          >
            <p className="small muted" style={{ marginBottom: 10 }} role="status">
              Showing {filteredAlerts.length} of {alerts.length} loaded alerts, newest first.
              Device includes sensor and connectivity findings. Counts are not lifetime totals.
            </p>
            {filteredAlerts.length === 0 ? (
              <Empty>
                {alerts.length === 0
                  ? "No alert history available. This does not establish patient stability or sensor reliability."
                  : `No ${alertFilter === "clinical" ? "clinical" : "device"} alerts in the loaded history. Select another filter to review other findings.`}
              </Empty>
            ) : (
              <div className="col scroll" style={{ gap: 10 }}>
                {filteredAlerts.map((alert, i) => (
                  <AlertCard alert={alert} key={`${alert.timestamp}-${alert.alert_kind}-${i}`} />
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="col">
          <ProfilePanel profile={profile} />
          <SensorPanel
            artifact={state.artifact}
            suppressedCount={state.suppressed_count}
            artifactCounts={state.artifact_counts}
          />
          <Panel title="Reading tally" hint="since the last reset">
            <table className="table">
              <tbody>
                {(["NORMAL", "WATCH", "REVIEW", "URGENT"] as const).map((tier) => (
                  <tr key={tier}>
                    <td>
                      <TierBadge tier={tier} />
                    </td>
                    <td className="num">{state.tier_counts[tier] ?? 0}</td>
                  </tr>
                ))}
                <tr>
                  <td className="muted">Baseline established</td>
                  <td className="num">{state.baseline_ready ? "yes" : "learning"}</td>
                </tr>
              </tbody>
            </table>
            <p className="small muted" style={{ marginTop: 10 }}>
              Tier counts include device-suppressed readings; these are not evidence
              of patient stability.
            </p>
          </Panel>
        </div>
      </div>

      <SavedReportsPanel patientId={patientId} refreshToken={savedRefresh} />

      {report && reportOpen && (
        <ReportModal
          report={report}
          session={session}
          onClose={() => setReportOpen(false)}
          onSaved={() => setSavedRefresh((v) => v + 1)}
        />
      )}
    </div>
  );
}