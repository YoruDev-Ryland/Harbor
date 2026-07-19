import type { NotifyKind } from "./notify.js";

/**
 * Branded HTML email. Emails can't use our CSS variables or external styles, so
 * everything is inlined and table-based for broad client support (Gmail, Apple
 * Mail, Outlook). It mirrors Harbor's dark, brass-accented dockyard look.
 */

export interface EmailField {
  label: string;
  value: string;
}

export interface EmailContent {
  kind: NotifyKind;
  title: string;
  body?: string;
  fields?: EmailField[];
  /** optional call-to-action button */
  url?: string;
  urlLabel?: string;
  siteTitle: string;
}

const KIND: Record<NotifyKind, { color: string; label: string }> = {
  success: { color: "#58c26a", label: "Success" },
  info: { color: "#f0b64a", label: "Notice" },
  warn: { color: "#e0b04b", label: "Warning" },
  error: { color: "#e06060", label: "Alert" },
};

// palette lifted from the Dockyard theme
const BG = "#071019";
const CARD = "#0f2233";
const LINE = "#20384b";
const TEXT = "#e6f0f7";
const MUTED = "#8aa3b5";

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const k = KIND[c.kind] ?? KIND.info;
  const fields = c.fields?.filter((f) => f.value != null && f.value !== "") ?? [];

  const fieldsHtml = fields.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-top:1px solid ${LINE};">
        ${fields
          .map(
            (f) => `<tr>
              <td style="padding:9px 0;border-bottom:1px solid ${LINE};color:${MUTED};font-size:13px;white-space:nowrap;vertical-align:top;width:120px;">${esc(f.label)}</td>
              <td style="padding:9px 0;border-bottom:1px solid ${LINE};color:${TEXT};font-size:13px;word-break:break-word;">${esc(f.value)}</td>
            </tr>`
          )
          .join("")}
      </table>`
    : "";

  const buttonHtml = c.url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;">
        <tr><td bgcolor="${k.color}" style="border-radius:8px;">
          <a href="${esc(c.url)}" style="display:inline-block;padding:11px 20px;color:#0a1420;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">${esc(c.urlLabel || "Open")}</a>
        </td></tr>
      </table>`
    : "";

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:${BG};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:${CARD};border:1px solid ${LINE};border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:16px 24px;border-bottom:1px solid ${LINE};border-left:4px solid ${k.color};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="color:${TEXT};font-size:15px;font-weight:700;letter-spacing:0.02em;">⚓&nbsp; ${esc(c.siteTitle)}</td>
              <td align="right"><span style="display:inline-block;padding:3px 11px;border-radius:999px;background:${k.color}22;color:${k.color};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">${k.label}</span></td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <div style="color:${TEXT};font-size:19px;font-weight:700;line-height:1.3;">${esc(c.title)}</div>
            ${c.body ? `<div style="color:${MUTED};font-size:14px;line-height:1.5;margin-top:8px;white-space:pre-line;">${esc(c.body)}</div>` : ""}
            ${fieldsHtml}
            ${buttonHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:14px 24px;border-top:1px solid ${LINE};color:${MUTED};font-size:11.5px;">
            Sent by ${esc(c.siteTitle)} · Harbor
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    c.title,
    c.body ?? "",
    ...fields.map((f) => `${f.label}: ${f.value}`),
    c.url ? `${c.urlLabel || "Open"}: ${c.url}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { html, text };
}
