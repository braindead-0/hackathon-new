import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { GeneratedReport } from "./reportGenerator";

const BLUE = "#1a3fa0";
const RED = "#bb2222";
const INK = "#172033";

/** Standard PDF fonts are not Unicode fonts. Preserve clinical symbols and numbers. */
export function pdfText(value: string): string {
  const symbols: Record<string, string> = {
    "→": " -> ", "←": " <- ", "↔": " <-> ", "⇒": " => ",
    "↑": " increased ", "↓": " decreased ", "↗": " rising ", "↘": " falling ",
    "–": "-", "—": " - ", "−": "-", "‑": "-", "‐": "-",
    "±": "+/-", "≥": ">=", "≤": "<=", "≠": "!=", "≈": "approximately ",
    "°": " deg ", "µ": "u", "μ": "u", "×": "x", "÷": "/",
    "·": " / ", "•": "-", "…": "...", "∞": "infinity",
    "‘": "'", "’": "'", "“": '"', "”": '"', "✓": "yes", "✗": "no",
    "½": "1/2", "¼": "1/4", "¾": "3/4", "β": "beta", "Δ": "delta",
  };
  return Array.from(value, (char) => symbols[char] ?? char).join("")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (digits) => `^${digits.normalize("NFKD")}`)
    .normalize("NFKD") // Includes subscript digits: SpO₂ -> SpO2.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[^\x20-\x7e\n]/gu, (char) => `[U+${char.codePointAt(0)!.toString(16).toUpperCase()}]`);
}

function utcDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? pdfText(value) : `${date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
}

/** Vector/text PDF: no screenshot dependencies, canvas, or fabricated image placeholders. */
export function buildReportPdf(report: GeneratedReport): jsPDF {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: false });
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const margin = 16;
  const top = 42;
  const bottom = height - 23;
  const contentWidth = width - 2 * margin;
  let y = top;

  doc.setProperties({ title: pdfText(report.title), author: pdfText(report.authorLabel), creator: "VitalTwin" });

  const room = (space: number) => {
    if (y + space > bottom) {
      doc.addPage();
      y = top;
    }
  };

  const text = (value: string, size = 10, bold = false, color = INK, indent = 0) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(color);
    const lines = doc.splitTextToSize(pdfText(value), contentWidth - indent) as string[];
    const lineHeight = size * 0.3528 * 1.4;
    for (const line of lines) {
      room(lineHeight);
      doc.text(line, margin + indent, y);
      y += lineHeight;
    }
    y += 2;
  };

  const heading = (title: string) => {
    room(19);
    y += 3;
    text(title, 11, true, RED);
  };

  const table = (headers: string[], rows: string[][]) => {
    room(16);
    autoTable(doc, {
      startY: y,
      head: [headers.map(pdfText)],
      body: rows.map((row) => row.map(pdfText)),
      theme: "grid",
      margin: { top, bottom: height - bottom, left: margin, right: margin },
      styles: {
        font: "helvetica", fontSize: 9, cellPadding: 2.2,
        overflow: "linebreak", lineColor: "#adb8cb", lineWidth: 0.2,
        textColor: INK, valign: "top",
      },
      headStyles: { fillColor: BLUE, textColor: "#ffffff", fontStyle: "bold" },
      alternateRowStyles: { fillColor: "#f4f7fc" },
      showHead: "everyPage",
      rowPageBreak: "avoid",
      didDrawPage: (data) => { y = data.cursor?.y ?? top; },
    });
    y += 7;
  };

  text(report.title, 15, true, BLUE);
  text(report.subtitle, 10);
  text(`Generated: ${utcDate(report.generatedAt)}`, 9);
  text(`Prepared for / by: ${report.authorLabel}`, 9);
  const profile = report.visualContext?.state.profile;
  if (profile) {
    table(["Patient", "Patient ID", "Age / Sex", "Discharged"], [[
      profile.display_name, profile.patient_id,
      `${profile.age_years} years / ${profile.sex}`, profile.discharged_on,
    ]]);
  }

  // Include the measured vitals even when narrative sections only list abnormalities.
  const vc = report.visualContext;
  const observation = vc?.liveOverride ?? vc?.state.observation;
  if (vc && observation) {
    heading("Vital Signs");
    if (vc.state.suppressed && !vc.liveOverride) {
      text("Unreliable device signal: clinical scoring withheld. Values are not evidence of stability.", 9, false, RED);
    }
    const metrics = [
      ["heart_rate", "Heart rate", "bpm"],
      ["spo2", "Oxygen (SpO2)", "%"],
      ["respiratory_rate", "Respiratory rate", "br/min"],
      ["temperature", "Temperature", "deg C"],
    ] as const;
    table(["Test Name", "Result", "Personal baseline (not a safety range)"], metrics.map(([key, label, unit]) => {
      const value = observation[key];
      const baseline = vc.state.baselines?.[key];
      return [label, value == null ? "Not reported" : `${value} ${unit}`,
        baseline ? `${baseline.center} +/- ${baseline.spread} ${unit}` : "Not established"];
    }));
    text(`SpO2 target: ${vc.state.profile.spo2_target.join("-")}% (Scale ${vc.state.profile.spo2_scale})`, 9);
  }

  for (const section of report.sections) {
    heading(section.title);
    for (const paragraph of section.paragraphs ?? []) text(paragraph);
    for (const bullet of section.bullets ?? []) text(`- ${bullet}`, 10, false, INK, 2);
    if (section.table) table(section.table.headers, section.table.rows);
  }

  const notes = report.doctorNotes;
  if (notes) {
    heading("Clinician Addendum");
    if (notes.editedBy) text(`Edited by: ${notes.editedBy}`, 9);
    if (notes.editedAt) text(`Edited: ${utcDate(notes.editedAt)}`, 9);
    if (notes.assessment) text(`Assessment: ${notes.assessment}`);
    if (notes.plan) text(`Plan: ${notes.plan}`);
    if (notes.followUp) text(`Follow-up: ${notes.followUp}`);
  }
  heading("Safety notice");
  text(report.disclaimer, 9);

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(BLUE);
    doc.setLineWidth(0.6);
    doc.line(margin, 11, width - margin, 11);
    doc.setFont("times", "bold");
    doc.setFontSize(19);
    doc.setTextColor(BLUE);
    doc.text("VITALTWIN LAB", width / 2, 19, { align: "center" });
    doc.setFontSize(12);
    doc.text("VITALTWIN DIGITAL HEALTH CENTRE", width / 2, 25, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text("Post-Discharge Remote Monitoring / Clinical Decision Support / Synthetic Data", width / 2, 30, { align: "center" });
    doc.line(margin, 34, width - margin, 34);
    doc.setDrawColor(RED);
    doc.setLineWidth(0.3);
    doc.line(margin, height - 17, width - margin, height - 17);
    doc.setTextColor(RED);
    doc.text("Care is Our Concern", margin, height - 12);
    doc.setTextColor(INK);
    doc.text(`Page ${page} of ${pageCount}`, width - margin, height - 12, { align: "right" });
    doc.setFontSize(7);
    doc.text("Clinical decision support, not a medical diagnosis.", margin, height - 7);
  }
  return doc;
}

export function reportPdfAttachment(report: GeneratedReport): { pdf_base64: string; pdf_filename: string } {
  const dataUri = buildReportPdf(report).output("datauristring");
  const name = pdfText(report.filename).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return { pdf_base64: dataUri.slice(dataUri.indexOf(",") + 1), pdf_filename: `${name || "report"}.pdf` };
}
