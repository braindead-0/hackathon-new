import { useRef, useState } from "react";
import { clinicalApi } from "./api";
import { activeSessionInput, type AuthSession } from "./auth";
import { printReport, type GeneratedReport } from "./reportGenerator";

export async function emailGeneratedReport(report: GeneratedReport, session: AuthSession) {
  // Capture identity before any await; never look up loadSession or the global active recipient.
  const identity = activeSessionInput(session);
  const { reportPdfAttachment } = await import("./reportPdf");
  const attachment = reportPdfAttachment(report);
  const recipient = await clinicalApi.setActiveSession(identity);
  if (!recipient.ok || !recipient.owner_id || !recipient.email) {
    throw new Error("Could not register the report recipient. Email was not requested.");
  }
  // Exactly one POST, with no automatic retry (a lost response could already have sent mail).
  const result = await clinicalApi.emailReport({
    owner_id: recipient.owner_id,
    title: report.title,
    subtitle: report.subtitle,
    ...attachment,
  });
  if (result.sent !== true || result.error) {
    throw new Error(result.error || "The email provider did not confirm sending the report.");
  }
  return { ...result, to: result.to || recipient.email };
}

/** Non-async on purpose: open the print window in the Generate click's user gesture. */
export function printAndEmailReport(report: GeneratedReport, session: AuthSession) {
  const capturedSession = { ...session };
  printReport(report);
  return emailGeneratedReport(report, capturedSession);
}

type EmailStatus = { sending: boolean; failed: boolean; message: string };

export function useReportEmail() {
  const [status, setStatus] = useState<EmailStatus>({ sending: false, failed: false, message: "" });
  const latest = useRef(0);

  const generate = (report: GeneratedReport, session: AuthSession) => {
    const attempt = ++latest.current;
    setStatus({ sending: true, failed: false, message: "Preparing and sending report PDF…" });
    // Called only by Generate handlers, never by an effect, saved-report reopen, or download.
    void printAndEmailReport(report, session)
      .then((result) => {
        if (attempt === latest.current) setStatus({ sending: false, failed: false,
          message: `Report PDF sent to ${result.to} (accepted by email provider; inbox delivery is not guaranteed).` });
      })
      .catch((reason: unknown) => {
        if (attempt === latest.current) setStatus({ sending: false, failed: true,
          message: `Report email failed or was not confirmed: ${reason instanceof Error ? reason.message : "Unknown error"}. No automatic retry was made.` });
      });
  };
  return { generate, status };
}

export function ReportEmailStatus({ status }: { status: EmailStatus }) {
  if (!status.message) return null;
  return <div className={`notice${status.failed ? " notice--warn" : ""}`} role={status.failed ? "alert" : "status"}>
    {status.message}
  </div>;
}
