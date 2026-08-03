/**
 * DOCX renderer (§8): the minimal WordprocessingML package, built on the
 * deterministic zip writer. Direct run formatting instead of a styles
 * hierarchy, and plain "–" bullet paragraphs instead of numbering.xml — the
 * document opens identically in Word and LibreOffice, and the package stays
 * small enough to read.
 *
 * Consumes the RenderableResume IR only; it knows nothing about facts,
 * variants or the database.
 */

import type { RenderableResume, ResumeSection } from "@domain/dossier/resume.ts";
import { contactLine } from "@domain/dossier/resume.ts";
import { buildZip, type ZipEntry } from "./zip.ts";

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** One run with direct formatting. Sizes are half-points ("sz" 20 = 10pt). */
function run(
  text: string,
  opts: { bold?: boolean; italic?: boolean; size: number; color?: string },
): string {
  const props = [
    opts.bold === true ? "<w:b/>" : "",
    opts.italic === true ? "<w:i/>" : "",
    opts.color !== undefined ? `<w:color w:val="${opts.color}"/>` : "",
    `<w:sz w:val="${opts.size}"/>`,
  ].join("");
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

/** Paragraph spacing is in twentieths of a point. */
function paragraph(
  runs: string,
  opts: { before?: number; after?: number; indent?: number } = {},
): string {
  const spacing = `<w:spacing w:before="${opts.before ?? 0}" w:after="${opts.after ?? 0}"/>`;
  const indent = opts.indent !== undefined ? `<w:ind w:left="${opts.indent}"/>` : "";
  return `<w:p><w:pPr>${spacing}${indent}</w:pPr>${runs}</w:p>`;
}

function sectionXml(section: ResumeSection): string {
  const parts: string[] = [];

  if (section.kind === "summary") {
    for (const text of section.paragraphs) {
      parts.push(paragraph(run(text, { size: 20 }), { after: 120 }));
    }
    return parts.join("");
  }

  if (section.kind === "skills") {
    parts.push(paragraph(run("Skills", { bold: true, size: 22 }), { before: 200, after: 80 }));
    parts.push(paragraph(run(section.items.join("  ·  "), { size: 20 }), { after: 120 }));
    return parts.join("");
  }

  parts.push(
    paragraph(run(section.heading, { bold: true, size: 22 }), { before: 200, after: 80 }),
  );
  for (const entry of section.entries) {
    const meta = [entry.organization, entry.dates]
      .filter((v): v is string => v !== undefined)
      .join("  ·  ");
    parts.push(paragraph(run(entry.title, { bold: true, size: 20 }), { before: 80, after: 20 }));
    if (meta !== "") {
      parts.push(paragraph(run(meta, { italic: true, size: 18, color: "555555" }), { after: 60 }));
    }
    for (const bullet of entry.bullets) {
      parts.push(
        paragraph(run("–  ", { size: 20 }) + run(bullet, { size: 20 }), {
          after: 40,
          indent: 240,
        }),
      );
    }
  }
  return parts.join("");
}

function documentXml(resume: RenderableResume): string {
  const body: string[] = [];
  body.push(paragraph(run(resume.identity.name, { bold: true, size: 40 }), { after: 40 }));
  const contact = contactLine(resume.identity);
  if (contact !== "") {
    body.push(paragraph(run(contact, { size: 18, color: "555555" }), { after: 160 }));
  }
  for (const section of resume.sections) body.push(sectionXml(section));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join("")}
<w:sectPr>
<w:pgSz w:w="12240" w:h="15840"/>
<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/>
</w:sectPr>
</w:body>
</w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export function renderResumeDocx(resume: RenderableResume): Uint8Array {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { path: "_rels/.rels", data: encoder.encode(ROOT_RELS) },
    { path: "word/document.xml", data: encoder.encode(documentXml(resume)) },
  ];
  return buildZip(entries);
}
