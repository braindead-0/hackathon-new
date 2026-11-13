import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clinicalApi } from "./api";
import { activeSessionInput, type AuthSession } from "./auth";
import { printReport, type GeneratedReport } from "./reportGenerator";
import { printAndEmailReport } from "./reportEmail";

vi.mock("./reportGenerator", () => ({ printReport: vi.fn() }));
vi.mock("./reportPdf", () => ({ reportPdfAttachment: () => ({ pdf_base64: "JVBERi0xLjc=", pdf_filename: "report.pdf" }) }));

const report: GeneratedReport = {
  id: "test", kind: "doctor-ward", title: "Ward report", subtitle: "Snapshot",
  generatedAt: "2026-11-12T00:00:00Z", authorLabel: "Doctor A", filename: "report.md",
  disclaimer: "Test only", sections: [],
};
const doctor: AuthSession = { role: "doctor", clinicianId: "DOC-A", clinicianName: "Doctor A", email: " doctor@example.test " };
const patient: AuthSession = { role: "patient", patientId: "p1", patientName: "Patient One" };

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => { vi.mocked(printReport).mockClear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Generate print and email flow (mocked HTTP only)", () => {
  it("opens print synchronously, captures identity, then registers and emails exactly once", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, owner_id: "doctor:DOC-A", email: "doctor@example.test" }))
      .mockResolvedValueOnce(response({ sent: true, to: "doctor@example.test", id: "provider-id" }));
    vi.stubGlobal("fetch", fetchMock);
    const session = { ...doctor };
    const pending = printAndEmailReport(report, session);
    expect(printReport).toHaveBeenCalledExactlyOnceWith(report);
    expect(fetchMock).not.toHaveBeenCalled();
    session.email = "other-tab@example.test";
    await expect(pending).resolves.toMatchObject({ sent: true, to: "doctor@example.test" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/clinical/session/active");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ role: "doctor", display_name: "Doctor A",
      clinician_id: "DOC-A", patient_id: null, email: "doctor@example.test" });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/clinical/reports/email");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ owner_id: "doctor:DOC-A", title: "Ward report",
      subtitle: "Snapshot", pdf_base64: "JVBERi0xLjc=", pdf_filename: "report.pdf" });
  });

  it("uses the server fallback for an older patient session with no email", async () => {
    const register = vi.spyOn(clinicalApi, "setActiveSession").mockResolvedValue({ ok: true, owner_id: "patient:p1", email: "server-default@example.test" });
    const send = vi.spyOn(clinicalApi, "emailReport").mockResolvedValue({ sent: true });
    await expect(printAndEmailReport(report, patient)).resolves.toMatchObject({ to: "server-default@example.test" });
    expect(register).toHaveBeenCalledExactlyOnceWith({ role: "patient", display_name: "Patient One", patient_id: "p1", clinician_id: null, email: null });
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ owner_id: "patient:p1" }));
    expect(activeSessionInput({ ...doctor, email: "   " }).email).toBeNull();
    expect(activeSessionInput({ role: "doctor", clinicianName: "Legacy", clinicianId: "legacy" }).email).toBeNull();
  });

  it("keeps concurrent tab identities attached to their own reports, one send per click", async () => {
    let resolveDoctor!: (value: { ok: boolean; owner_id: string; email: string }) => void;
    vi.spyOn(clinicalApi, "setActiveSession").mockImplementation((body) => body.role === "doctor"
      ? new Promise((resolve) => { resolveDoctor = resolve; })
      : Promise.resolve({ ok: true, owner_id: "patient:p1", email: "patient@example.test" }));
    const send = vi.spyOn(clinicalApi, "emailReport").mockResolvedValue({ sent: true });
    const first = printAndEmailReport(report, doctor);
    const second = printAndEmailReport({ ...report, title: "Patient report" }, patient);
    await second;
    resolveDoctor({ ok: true, owner_id: "doctor:DOC-A", email: "doctor@example.test" });
    await first;
    expect(printReport).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([body]) => [body.owner_id, body.title])).toEqual([
      ["patient:p1", "Patient report"], ["doctor:DOC-A", "Ward report"],
    ]);
  });

  it("surfaces Resend rejection and never retries after an HTTP error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, owner_id: "doctor:DOC-A", email: "doctor@example.test" }))
      .mockResolvedValueOnce(response({ detail: "Resend (403): recipient is not verified" }, 502));
    vi.stubGlobal("fetch", fetchMock);
    await expect(printAndEmailReport(report, doctor)).rejects.toThrow("Resend (403): recipient is not verified");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(printReport).toHaveBeenCalledTimes(1);
  });

  it("does not claim success for sent:false or an unconfirmed response", async () => {
    vi.spyOn(clinicalApi, "setActiveSession").mockResolvedValue({ ok: true, owner_id: "doctor:DOC-A", email: "doctor@example.test" });
    const send = vi.spyOn(clinicalApi, "emailReport").mockResolvedValue({ sent: false, error: "Provider blocked recipient" });
    await expect(printAndEmailReport(report, doctor)).rejects.toThrow("Provider blocked recipient");
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValue({} as Awaited<ReturnType<typeof clinicalApi.emailReport>>);
    await expect(printAndEmailReport(report, doctor)).rejects.toThrow("did not confirm");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to global ownership if registration fails", async () => {
    vi.spyOn(clinicalApi, "setActiveSession").mockResolvedValue({ ok: false, owner_id: "", email: null });
    const send = vi.spyOn(clinicalApi, "emailReport");
    await expect(printAndEmailReport(report, doctor)).rejects.toThrow("Could not register");
    expect(send).not.toHaveBeenCalled();
    expect(printReport).toHaveBeenCalledTimes(1);
  });
});
