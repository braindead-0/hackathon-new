import { describe, expect, it } from "vitest";
import { buildReportPdf, pdfText, reportPdfAttachment } from "./reportPdf";
import type { GeneratedReport } from "./reportGenerator";
import type { PatientStatePayload } from "./types";

const report: GeneratedReport = {
  id: "pdf-test", kind: "doctor-patient", title: "Clinical Monitoring Report",
  subtitle: "Recovery follow-up", generatedAt: "2026-11-12T10:30:00.000Z",
  authorLabel: "Dr. Rao / DOC-204", filename: "clinical-report-p1.md",
  disclaimer: "Decision support, not a diagnosis.",
  sections: [{
    title: "Immediate concerns", paragraphs: ["SpO₂ ↓ 88–92%; temperature 38.6 °C."],
    bullets: ["Heart rate ≥ 130 bpm — review now."],
    table: { headers: ["Parameter", "Result"], rows: [["SpO₂", "88%"], ["Temperature", "38.6 °C"]] },
  }],
  doctorNotes: {
    assessment: "Persistent hypoxemia", plan: "Contact care team", followUp: "Review in 24 hours",
    editedBy: "Dr. Rao", editedAt: "2026-11-12T11:00:00.000Z",
  },
};

describe("report PDF", () => {
  it("transliterates clinical symbols without dropping values or signs", () => {
    expect(pdfText("SpO₂ ↓ 88–92% → ≥ 95%; T 38.6°C ±0.5; Δ −2; 10³/µL"))
      .toBe("SpO2  decreased  88-92%  ->  >= 95%; T 38.6 deg C +/-0.5; delta -2; 10^3/uL");
    expect(pdfText("José — β-blocker ← ≤60; ½ dose"))
      .toBe("Jose  -  beta-blocker  <-  <=60; 1/2 dose");
    expect(pdfText("未 １２.５")).toBe("[U+672A] 12.5");
  });

  it("produces genuine PDF base64 with branding, all sections, dates, notes, and a PDF filename", () => {
    const attachment = reportPdfAttachment(report);
    const pdf = atob(attachment.pdf_base64);
    expect(attachment.pdf_filename).toBe("clinical-report-p1.pdf");
    expect(attachment.pdf_base64).not.toContain("data:");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    for (const content of ["VITALTWIN LAB", "Clinical Monitoring Report", "Recovery follow-up", "Dr. Rao / DOC-204",
      "2026-11-12 10:30:00 UTC", "Immediate concerns", "SpO2", "88%", "38.6", "Parameter",
      "Clinician Addendum", "Persistent hypoxemia", "Contact care team", "Review in 24 hours",
      "2026-11-12 11:00:00 UTC", "Decision support, not a diagnosis.", "Page 1 of", "Care is Our Concern"]) {
      expect(pdf).toContain(content);
    }
    expect(pdf).not.toContain("/Subtype /Image");
  });

  it("includes patient identity and measured values from visual context", () => {
    const state: PatientStatePayload = {
      patient_id: "p1", timestamp: report.generatedAt, tier: "NORMAL", alert_kind: "SENSOR",
      news2: null, drift: [], artifact: null, explanation: null, suppressed: true,
      baseline_ready: true, stored_observations: 4, suppressed_count: 1,
      tier_counts: {}, artifact_counts: {}, disclaimer: report.disclaimer,
      profile: { display_name: "Patient One", patient_id: "p1", age_years: 68, sex: "F",
        discharged_on: "2026-11-01", spo2_target: [88, 92], spo2_scale: 2,
        conditions: [], medications: [], hypercapnic_respiratory_failure: true, beta_blocked: false,
        pulse_correction_bpm: 0, notes: "", source: "test", scenario: "copd_exacerbation", rules: [] },
      observation: { timestamp: report.generatedAt, heart_rate: 101, spo2: 89.5, respiratory_rate: 23,
        temperature: 38.67, systolic_bp: null, diastolic_bp: null, activity_intensity: 0, source: "test" },
      baselines: { spo2: { center: 91, spread: 1.2 } },
    };
    const pdf = buildReportPdf({ ...report, visualContext: { state, alerts: [], readings: [] } }).output();
    for (const content of ["Patient One", "p1", "68 years / F", "2026-11-01", "101 bpm", "89.5 %",
      "23 br/min", "38.67 deg C", "91 +/- 1.2", "88-92%", "clinical scoring withheld"]) {
      expect(pdf).toContain(content);
    }
  });

  it("wraps and paginates long paragraphs, tables and addenda with repeated headers and footers", () => {
    const doc = buildReportPdf({ ...report,
      sections: [
        { title: "Long narrative", paragraphs: ["Observation 123.45 remains recorded. ".repeat(300) + "NARRATIVE_END"] },
        { title: "Results", table: { headers: ["Result", "Explanation"], rows: [
          ...Array.from({ length: 100 }, (_, i) => [`VALUE_${i}`, `SpO₂ ${88 + i / 100}%: ${"Clinical detail. ".repeat(10)}`]),
          ["LONG_CELL", "Cell detail 37.6. ".repeat(250) + "CELL_END"],
        ] } },
      ],
      doctorNotes: { assessment: "Assessment text. ".repeat(300), plan: "PLAN_END", followUp: "FOLLOWUP_END" },
    });
    const pdf = doc.output();
    const pages = doc.getNumberOfPages();
    expect(pages).toBeGreaterThan(5);
    for (let page = 1; page <= pages; page += 1) expect(pdf).toContain(`Page ${page} of ${pages}`);
    expect(pdf.match(/VITALTWIN LAB/g)).toHaveLength(pages);
    expect(pdf.match(/\(Explanation\) Tj/g)!.length).toBeGreaterThan(1);
    for (const content of ["NARRATIVE_END", "VALUE_99", "CELL_END", "PLAN_END", "FOLLOWUP_END"]) {
      expect(pdf).toContain(content);
    }
    // Text origins stay inside the physical page, including automatic table page breaks.
    for (const match of pdf.matchAll(/(-?[\d.]+) (-?[\d.]+) Td/g)) {
      expect(Number(match[1])).toBeGreaterThan(10);
      expect(Number(match[1])).toBeLessThan(595);
      expect(Number(match[2])).toBeGreaterThan(10);
      expect(Number(match[2])).toBeLessThan(830);
    }
  });
});
