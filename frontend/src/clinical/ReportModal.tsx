import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clinicalApi } from "./api";
import type { AuthSession } from "./auth";
import {
  buildDoctorPatientReport,
  buildPatientHealthReport,
  printReport,
  reportToHtml,
  reportToMarkdown,
  type DoctorNotes,
  type GeneratedReport,
  type ReportSection,
  type ReportTable,
} from "./reportGenerator";
import { ReportEmailStatus, emailGeneratedReport } from "./reportEmail";

const EMPTY_NOTES: DoctorNotes = { assessment: "", plan: "", followUp: "" };

interface DraftSection {
  title: string;
  paragraphs?: string;
  bullets?: string;
  table?: ReportTable;
}

interface ReportDraft {
  title: string;
  subtitle: string;
  sections: DraftSection[];
}

function toDraft(report: GeneratedReport): ReportDraft {
  return {
    title: report.title,
    subtitle: report.subtitle,
    sections: report.sections.map((s) => ({
      title: s.title,
      paragraphs: s.paragraphs ? s.paragraphs.join("\n") : undefined,
      bullets: s.bullets ? s.bullets.join("\n") : undefined,
      table: s.table,
    })),
  };
}

function draftSections(draft: ReportDraft): ReportSection[] {
  return draft.sections.map((s) => ({
    title: s.title,
    paragraphs: s.paragraphs
      ?.split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    bullets: s.bullets
      ?.split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    table: s.table,
  }));
}

export function ReportModal({
  report,
  session,
  onClose,
  onSaved,
}: {
  report: GeneratedReport;
  session?: Extract<AuthSession, { role: "doctor" }> | null;
  onClose: () => void;
  onSaved?: (key: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [waPhone, setWaPhone] = useState("");
  const [waStatus, setWaStatus] = useState<string | null>(null);
  const [waSending, setWaSending] = useState(false);
  const [audience, setAudience] = useState<"doctor" | "patient">(
    report.kind === "patient-summary" ? "patient" : "doctor",
  );
  const [notes, setNotes] = useState<DoctorNotes>(report.doctorNotes ?? EMPTY_NOTES);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [notifyPhone, setNotifyPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(report.recordKey ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [emailState, setEmailState] = useState<{ sending: boolean; failed: boolean; message: string }>({
    sending: false,
    failed: false,
    message: "",
  });

  const activeReport = useMemo(() => {
    const vc = report.visualContext;
    if (!vc || report.kind === "doctor-ward") return report;
    // A reopened record already carries any saved edits — keep them.
    if (report.kind === (audience === "patient" ? "patient-summary" : "doctor-patient")) return report;
    if (audience === "patient") {
      return buildPatientHealthReport(vc.state, vc.alerts, vc.readings, vc.liveOverride);
    }
    return buildDoctorPatientReport(vc.state, vc.alerts, vc.readings, vc.session);
  }, [audience, report]);

  const vc = activeReport.visualContext;
  const patientId = vc?.state.patient_id ?? null;
  const audienceEditable = audience === "doctor";
  const canEditNotes = audienceEditable && Boolean(patientId);
  const canEditText = audienceEditable && report.kind !== "patient-summary";
  const doctorSession = vc?.session ?? session ?? null;
  const clinicianLabel = doctorSession
    ? `${doctorSession.clinicianName} (${doctorSession.clinicianId})`
    : "Attending Clinician";

  const displayReport = useMemo<GeneratedReport>(
    () => ({
      ...activeReport,
      title: draft?.title ?? activeReport.title,
      subtitle: draft?.subtitle ?? activeReport.subtitle,
      sections: draft ? draftSections(draft) : activeReport.sections,
      doctorNotes: notes,
      recordKey: savedKey ?? report.recordKey,
    }),
    [activeReport, draft, notes, savedKey, report.recordKey],
  );

  // Exports carry a review stamp unless the report is saved (which already stamps it).
  const exportReport = useMemo<GeneratedReport>(() => {
    const edited =
      Boolean(draft) || Boolean(notes.assessment || notes.plan || notes.followUp);
    if (!edited || notes.editedBy || notes.editedAt) return displayReport;
    return {
      ...displayReport,
      doctorNotes: { ...notes, editedBy: clinicianLabel, editedAt: new Date().toISOString() },
    };
  }, [displayReport, draft, notes, clinicianLabel]);

  const startEditing = () => {
    if (!draft) setDraft(toDraft(displayReport));
    setEditing(true);
  };

  const switchAudience = (next: "doctor" | "patient") => {
    setAudience(next);
    setDraft(null);
    setEditing(false);
    setSaveStatus(null);
  };

  const patchSection = (index: number, patch: Partial<DraftSection>) => {
    setDraft((d) =>
      d ? { ...d, sections: d.sections.map((s, i) => (i === index ? { ...s, ...patch } : s)) } : d,
    );
  };

  const storedOnce = useRef(false);
  useEffect(() => {
    if (!patientId || storedOnce.current) return;
    storedOnce.current = true;
    clinicalApi
      .storeReport({
        patient_id: patientId,
        title: displayReport.title,
        html: reportToHtml(displayReport),
      })
      .catch(() => {});
  }, [patientId, displayReport]);

  const handleDownload = () => {
    const md = reportToMarkdown(exportReport);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportReport.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadHtml = () => {
    const html = reportToHtml(exportReport);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportReport.filename.replace(/\.md$/, ".html");
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    printReport(exportReport);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(reportToMarkdown(exportReport));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore clipboard error */
    }
  };

  const handleSave = async () => {
    if (!patientId) return;
    setSaving(true);
    setSaveStatus(null);
    const stamped: DoctorNotes = {
      ...notes,
      editedBy: clinicianLabel,
      editedAt: new Date().toISOString(),
    };
    let patientSummary: string | null = null;
    if (vc && report.kind === "doctor-patient") {
      try {
        const patientCopy = buildPatientHealthReport(
          vc.state,
          vc.alerts,
          vc.readings,
          vc.liveOverride,
        );
        patientSummary = reportToMarkdown({ ...patientCopy, doctorNotes: stamped }).slice(0, 4000);
      } catch {
        patientSummary = null;
      }
    }
    try {
      const res = await clinicalApi.saveRecord({
        patient_id: patientId,
        report: { ...displayReport, doctorNotes: stamped },
        patient_summary: patientSummary,
        whatsapp_to: notifyPhone.trim() || null,
        clinician_id: doctorSession?.role === "doctor" ? doctorSession.clinicianId : null,
      });
      setNotes(stamped);
      setSavedKey(res.key);
      const patientSent = res.notified?.patient?.sent === true;
      const clinicianSent = res.notified?.clinician?.sent === true;
      setSaveStatus(
        patientSent && clinicianSent
          ? "Saved. Patient and clinician notified."
          : clinicianSent
            ? "Saved. Clinician notified; patient WhatsApp number not on file."
            : patientSent
              ? "Saved. Patient notified; clinician channel unavailable."
              : "Saved to patient record. Notifications were not delivered.",
      );
      onSaved?.(res.key);
    } catch (e) {
      setSaveStatus(e instanceof Error ? e.message : "Failed to save report.");
    } finally {
      setSaving(false);
    }
  };

  const handleSendPdf = async () => {
    if (!doctorSession) return;
    setEmailState({ sending: true, failed: false, message: "Preparing and sending report PDF…" });
    try {
      const res = await emailGeneratedReport(exportReport, doctorSession);
      setEmailState({
        sending: false,
        failed: false,
        message: `Report PDF sent to ${res.to} (accepted by the email provider; inbox delivery is not guaranteed).`,
      });
    } catch (e) {
      setEmailState({
        sending: false,
        failed: true,
        message: `Report email failed or was not confirmed: ${e instanceof Error ? e.message : "Unknown error"}. No automatic retry was made.`,
      });
    }
  };

  const handleSendWhatsApp = async () => {
    setWaSending(true);
    setWaStatus("Sending report via WhatsApp...");
    const summary = reportToMarkdown(exportReport).slice(0, 1400);
    try {
      const res = await clinicalApi.sendWhatsappReport({
        title: displayReport.title,
        summary_text: summary,
        whatsapp_to: waPhone.trim() || null,
      });
      if (res.job_id) {
        for (let i = 0; i < 20; i += 1) {
          await new Promise((r) => window.setTimeout(r, 1000));
          const st = await clinicalApi.whatsappStatus(res.job_id);
          if (!st.queued) {
            setWaStatus(
              st.sent
                ? `Report sent via WhatsApp to ${st.recipients?.join(", ")}.`
                : `WhatsApp failed: ${st.error ?? "unknown error"}`,
            );
            break;
          }
        }
      }
    } catch (e) {
      setWaStatus(e instanceof Error ? e.message : "Failed to send report via WhatsApp");
    } finally {
      setWaSending(false);
    }
  };

  const mailtoHref = useMemo(() => {
    const subject = encodeURIComponent(exportReport.title);
    const body = encodeURIComponent(reportToMarkdown(exportReport).slice(0, 1800));
    return `mailto:?subject=${subject}&body=${body}`;
  }, [exportReport]);

  return createPortal(
    <div
      className="clinical report-modal"
      role="dialog"
      aria-modal="true"
      aria-label={displayReport.title}
    >
      <div className="report-modal__backdrop" onClick={onClose} />
      <div className="report-modal__dialog">
        <div className="report-modal__toolbar">
          <div className="row row--tight" style={{ alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <span className="small muted" style={{ fontWeight: 600 }}>
              {editing ? "Editing report" : "Report Preview"}
            </span>
            {vc && (
              <div className="seg" role="group" aria-label="Report audience">
                <button
                  type="button"
                  className={audience === "doctor" ? "seg__btn is-active" : "seg__btn"}
                  onClick={() => switchAudience("doctor")}
                >
                  Doctor Copy
                </button>
                <button
                  type="button"
                  className={audience === "patient" ? "seg__btn is-active" : "seg__btn"}
                  onClick={() => switchAudience("patient")}
                >
                  Patient Copy
                </button>
              </div>
            )}
            {canEditText && (
              <button
                type="button"
                className={`btn btn--small${editing ? " btn--primary" : ""}`}
                aria-pressed={editing}
                onClick={() => (editing ? setEditing(false) : startEditing())}
              >
                {editing ? "Done editing" : "Edit report"}
              </button>
            )}
          </div>
          <div className="report-modal__actions">
            {canEditNotes && (
              <button
                className="btn btn--small btn--primary"
                onClick={handleSave}
                disabled={saving || emailState.sending}
              >
                {saving ? "Saving…" : savedKey ? "Save edits" : "Save to record"}
              </button>
            )}
            {doctorSession && (
              <button
                className="btn btn--small"
                onClick={handleSendPdf}
                disabled={emailState.sending}
              >
                {emailState.sending ? "Sending PDF…" : "Send PDF by email"}
              </button>
            )}
            <button className="btn btn--small" onClick={handlePrint}>
              Print / Save PDF
            </button>
            <button className="btn btn--small" onClick={onClose} aria-label="Close report">
              Close
            </button>
          </div>
          <div className="report-modal__tools">
            <button className="btn btn--small" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy Markdown"}
            </button>
            <button className="btn btn--small" onClick={handleDownload}>
              Download .md
            </button>
            <button className="btn btn--small" onClick={handleDownloadHtml}>
              Download HTML
            </button>
            <a className="btn btn--small" href={mailtoHref}>
              Email Summary
            </a>
            <div className="row row--tight" style={{ alignItems: "center", gap: 4 }}>
              <input
                type="tel"
                className="input"
                style={{ width: 140, padding: "5px 8px", fontSize: 12 }}
                placeholder="WhatsApp # (or .env)"
                value={waPhone}
                onChange={(e) => setWaPhone(e.target.value)}
              />
              <button className="btn btn--small" onClick={handleSendWhatsApp} disabled={waSending}>
                {waSending ? "Sending..." : "Send via WhatsApp"}
              </button>
            </div>
          </div>
        </div>

        {(emailState.message || waStatus) && (
          <div className="report-modal__status">
            <ReportEmailStatus status={emailState} />
            {waStatus && <div className="notice">{waStatus}</div>}
          </div>
        )}

        <div className="report-modal__body">
          <iframe
            title={displayReport.title}
            srcDoc={reportToHtml(displayReport)}
            className="report-modal__preview"
            style={{ height: editing ? 320 : "62vh" }}
          />

          {editing && draft && (
            <section className="report-editor" aria-label="Edit report text">
              <div className="report-editor__head">
                <div>
                  <h3>Edit report text</h3>
                  <p className="small muted">
                    Correct headings and narrative text. Changes apply to the preview, downloads,
                    print and the emailed PDF. Auto-calculated tables stay locked — record corrected
                    values in the clinician addendum below.
                  </p>
                </div>
                <button className="btn btn--small" onClick={() => setDraft(toDraft(activeReport))}>
                  Revert text
                </button>
              </div>

              <div className="report-editor__grid">
                <label className="report-editor__field">
                  <span>Report title</span>
                  <input
                    className="input"
                    value={draft.title}
                    onChange={(e) => setDraft((d) => (d ? { ...d, title: e.target.value } : d))}
                  />
                </label>
                <label className="report-editor__field">
                  <span>Subtitle</span>
                  <input
                    className="input"
                    value={draft.subtitle}
                    onChange={(e) => setDraft((d) => (d ? { ...d, subtitle: e.target.value } : d))}
                  />
                </label>
              </div>

              <div className="report-editor__sections">
                {draft.sections.map((sec, index) => (
                  <details className="report-editor__section" key={`${sec.title}-${index}`} open={index === 0}>
                    <summary>
                      <span className="report-editor__index">{index + 1}</span>
                      <span className="report-editor__summary-title">
                        {sec.title || "Untitled section"}
                      </span>
                      <span className="report-editor__meta">
                        {sec.table
                          ? `${sec.table.rows.length} auto rows`
                          : sec.bullets !== undefined
                            ? `${sec.bullets.split("\n").filter((l) => l.trim()).length} lines`
                            : "text"}
                      </span>
                    </summary>
                    <div className="report-editor__body">
                      <label className="report-editor__field">
                        <span>Heading</span>
                        <input
                          className="input"
                          value={sec.title}
                          onChange={(e) => patchSection(index, { title: e.target.value })}
                        />
                      </label>
                      {sec.paragraphs !== undefined && (
                        <label className="report-editor__field">
                          <span>Paragraphs · one per line</span>
                          <textarea
                            className="input"
                            rows={Math.min(Math.max(sec.paragraphs.split("\n").length, 2), 6)}
                            value={sec.paragraphs}
                            onChange={(e) => patchSection(index, { paragraphs: e.target.value })}
                          />
                        </label>
                      )}
                      {sec.bullets !== undefined && (
                        <label className="report-editor__field">
                          <span>Bullets · one per line</span>
                          <textarea
                            className="input"
                            rows={Math.min(Math.max(sec.bullets.split("\n").length, 3), 10)}
                            value={sec.bullets}
                            onChange={(e) => patchSection(index, { bullets: e.target.value })}
                          />
                        </label>
                      )}
                      {sec.table && (
                        <p className="report-editor__locked">
                          {sec.table.rows.length} auto-calculated rows (NEWS2 / observations) —
                          locked to keep measurements auditable.
                        </p>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          )}

          {canEditNotes && (
            <section className="report-sheet__section report-editor__notes">
              <div className="spread" style={{ alignItems: "center", marginBottom: 8 }}>
                <h3 style={{ margin: 0, border: "none" }}>Clinician addendum (editable)</h3>
                <div className="row row--tight" style={{ alignItems: "center", gap: 8 }}>
                  {saveStatus && (
                    <span className="small" style={{ color: saveStatus.startsWith("Saved") ? "#166534" : "#991b1b" }}>
                      {saveStatus}
                    </span>
                  )}
                  <button className="btn btn--small" onClick={handleSave} disabled={saving}>
                    {saving ? "Saving…" : "Save addendum"}
                  </button>
                </div>
              </div>
              <p className="small muted" style={{ marginTop: 0 }}>
                Your assessment, plan, follow-up and any text edits are stored with this report and shown on the patient dashboard.
                Saving also messages the patient and the clinical team.
              </p>
              <label className="report-editor__field" style={{ display: "block", marginBottom: 10 }}>
                <span>Patient WhatsApp # (optional — blank uses the last number on file)</span>
                <input
                  className="input"
                  type="tel"
                  inputMode="tel"
                  placeholder="+91… · used only for this notification"
                  value={notifyPhone}
                  onChange={(e) => setNotifyPhone(e.target.value)}
                />
              </label>
              <label className="small" style={{ fontWeight: 600, display: "block", margin: "8px 0 4px" }}>
                Assessment
              </label>
              <textarea
                className="input"
                rows={3}
                placeholder="Clinical impression / interpretation of the flagged findings…"
                value={notes.assessment}
                onChange={(e) => setNotes((n) => ({ ...n, assessment: e.target.value }))}
              />
              <label className="small" style={{ fontWeight: 600, display: "block", margin: "8px 0 4px" }}>
                Plan
              </label>
              <textarea
                className="input"
                rows={3}
                placeholder="Management plan, medication changes, investigations…"
                value={notes.plan}
                onChange={(e) => setNotes((n) => ({ ...n, plan: e.target.value }))}
              />
              <label className="small" style={{ fontWeight: 600, display: "block", margin: "8px 0 4px" }}>
                Follow-up
              </label>
              <textarea
                className="input"
                rows={2}
                placeholder="Review interval, escalation criteria, next appointment…"
                value={notes.followUp}
                onChange={(e) => setNotes((n) => ({ ...n, followUp: e.target.value }))}
              />
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
