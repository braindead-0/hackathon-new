import { useCallback, useEffect, useState } from "react";
import { clinicalApi, type RecordSummary } from "./api";
import { ReportModal } from "./ReportModal";
import type { GeneratedReport } from "./reportGenerator";
import { Empty, Panel, dateTime } from "./ui";

export function SavedReportsPanel({
  patientId,
  refreshToken = 0,
}: {
  patientId: string;
  refreshToken?: number;
}) {
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<GeneratedReport | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    clinicalApi
      .listRecords(patientId)
      .then((res) => {
        if (!cancelled) {
          setRecords(res.records ?? []);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load saved reports");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, refreshToken, version]);

  const handleOpen = useCallback(async (key: string) => {
    setOpeningKey(key);
    try {
      const rep = await clinicalApi.getRecord(key);
      setOpen({ ...rep, recordKey: key });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open report");
    } finally {
      setOpeningKey(null);
    }
  }, []);

  return (
    <Panel
      title="Saved reports"
      hint="Persisted reports & clinician edits · click to reopen"
      action={
        <button className="btn btn--small" onClick={() => setVersion((v) => v + 1)}>
          Refresh
        </button>
      }
    >
      {loading ? (
        <p className="small muted" style={{ margin: 0 }}>
          Loading saved reports…
        </p>
      ) : error ? (
        <p className="small" style={{ margin: 0, color: "#991b1b" }}>
          {error}
        </p>
      ) : records.length === 0 ? (
        <Empty>No saved reports yet. Generate a report and click “Save to record”.</Empty>
      ) : (
        <div className="col" style={{ gap: 8 }}>
          {records.map((r) => (
            <button
              key={r.key}
              type="button"
              className="evidence__block"
              style={{
                textAlign: "left",
                cursor: "pointer",
                border: "1px solid var(--mist)",
                background: "var(--porcelain)",
                width: "100%",
              }}
              onClick={() => handleOpen(r.key)}
              disabled={openingKey === r.key}
            >
              <div className="spread" style={{ alignItems: "center", gap: 8 }}>
                <strong className="small">{r.title}</strong>
                {r.modified ? (
                  <span className="report-badge report-badge--watch">EDITED</span>
                ) : (
                  <span className="report-badge report-badge--normal">ORIGINAL</span>
                )}
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>
                {r.generatedAt ? `${dateTime(r.generatedAt)} UTC` : "—"}
                {r.editedBy ? ` · edited by ${r.editedBy}` : ""}
                {openingKey === r.key ? " · opening…" : ""}
              </div>
            </button>
          ))}
        </div>
      )}
      {open && (
        <ReportModal
          report={open}
          onClose={() => setOpen(null)}
          onSaved={() => setVersion((v) => v + 1)}
        />
      )}
    </Panel>
  );
}