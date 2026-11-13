import { useMemo, useState } from "react";
import type { AuthSession } from "../auth";
import { ReportModal } from "../ReportModal";
import { buildDoctorWardReport, type GeneratedReport } from "../reportGenerator";
import { ScenarioControls } from "../ScenarioControls";
import { WardTable } from "../WardTable";
import type { PatientRow, ReplayStatus, Tier } from "../types";
import { Empty, Panel, TIER_LABEL, TIER_RANK, TierBadge } from "../ui";

const WORKFLOW = [
  "Synthea profile",
  "Wearable / BIDMC",
  "FHIR R4 Observation",
  "HAPI storage",
  "Personalized NEWS2",
  "Rolling baseline",
  "Artifact check",
  "Watch / Review / Urgent",
];

function TierCensus({ rows }: { rows: PatientRow[] }) {
  const counts = useMemo(() => {
    const out: Record<Tier, number> = { NORMAL: 0, WATCH: 0, REVIEW: 0, URGENT: 0 };
    for (const row of rows) {
      if (row.timestamp && row.alert_kind === "CLINICAL" && !row.suppressed) {
        out[row.tier] += 1;
      }
    }
    return out;
  }, [rows]);
  const tiers: Tier[] = ["URGENT", "REVIEW", "WATCH", "NORMAL"];
  return (
    <div className="metrics metrics--census">
      {tiers.map((tier) => (
        <div className={`metric metric--${tier.toLowerCase()}`} key={tier}>
          <div className="metric__label">
            <TierBadge tier={tier} />
          </div>
          <div className="metric__value">{counts[tier]}</div>
          <div className="metric__note">
            {tier === "NORMAL"
              ? "no current clinical alert"
              : tier === "WATCH"
                ? "low-medium risk"
                : tier === "REVIEW"
                  ? "medium risk"
                  : "high risk"}
          </div>
        </div>
      ))}
    </div>
  );
}

export function WardPage({
  rows,
  replay,
  selected,
  session,
  onSelect,
  onRefresh,
}: {
  rows: PatientRow[];
  replay: ReplayStatus | null;
  selected: string | null;
  session: Extract<AuthSession, { role: "doctor" }>;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const [report, setReport] = useState<GeneratedReport | null>(null);
  const needingAttention = rows.filter(
    (r) => r.timestamp && r.alert_kind === "CLINICAL" && !r.suppressed && TIER_RANK[r.tier] > 0,
  ).length;
  const awaitingReadings = rows.filter((r) => !r.timestamp).length;
  const deviceIssues = rows.filter((r) => r.alert_kind && r.alert_kind !== "CLINICAL").length;
  const stored = rows.reduce((sum, r) => sum + r.stored_observations, 0);
  const suppressed = rows.reduce((sum, r) => sum + r.suppressed_count, 0);

  return (
    <div className="col">
      <section className="ward-head">
        <div className="ward-head__intro">
          <p className="ward-head__eyebrow">Post-discharge monitoring</p>
          <h1 className="section-title">Ward overview</h1>
          <p className="lede">
            {rows.length} synthetic discharge profiles on virtual wearable or BIDMC
            replay. <strong>{needingAttention}</strong> need clinical attention
            {deviceIssues > 0 && `; ${deviceIssues} have a device issue rather than a clinical one`}.
          </p>
        </div>
        <div className="ward-head__actions">
          <span className="chip chip--flat">{stored.toLocaleString()} FHIR observations</span>
          <span className="chip chip--flat chip--sensor">{suppressed} readings suppressed</span>
          <button
            className="btn btn--small btn--primary"
            onClick={() => setReport(buildDoctorWardReport(rows, session))}
          >
            Generate Ward Report
          </button>
        </div>
      </section>

      <TierCensus rows={rows} />
      <p className="small muted ward-census-note">
        Census counts trusted clinical readings only. {awaitingReadings} awaiting a
        first reading; {deviceIssues} with a device issue are not counted as Normal.
      </p>

      <Panel
        title="Patients"
        hint="most severe first · select a row for the full explanation"
        action={
          <span className="small muted">
            {rows.length} profiles · {needingAttention} flagged
          </span>
        }
        flush
      >
        <WardTable rows={rows} streams={replay?.streams ?? []} selected={selected} onSelect={onSelect} />
      </Panel>

      <ScenarioControls replay={replay} rows={rows} onChanged={onRefresh} />

      <Panel title="End-to-end path" hint="every reading takes all eight steps">
        <ol className="row row--tight" style={{ listStyle: "none", margin: 0, padding: 0, flexWrap: "wrap" }}>
          {WORKFLOW.map((step, i) => (
            <li key={step} className="row row--tight" style={{ alignItems: "center" }}>
              <span className="evidence__block" style={{ padding: "6px 10px" }}>
                <span className="small muted" style={{ marginRight: 6 }}>
                  {i + 1}
                </span>
                <span className="small" style={{ fontWeight: 580 }}>
                  {step}
                </span>
              </span>
              {i < WORKFLOW.length - 1 && <span className="muted">→</span>}
            </li>
          ))}
        </ol>
        {rows.length === 0 && (
          <Empty>
            Waiting for discharge profiles from the backend.
          </Empty>
        )}
      </Panel>

      <p className="small muted">
        Tiers: {TIER_LABEL.WATCH} = NEWS2 1–4 or a single parameter scoring 3 ·{" "}
        {TIER_LABEL.REVIEW} = NEWS2 5–6 · {TIER_LABEL.URGENT} = NEWS2 ≥ 7. Sustained
        drift from the patient's own baseline escalates one tier above the aggregate.
      </p>

      {report && (
        <ReportModal report={report} session={session} onClose={() => setReport(null)} />
      )}
    </div>
  );
}