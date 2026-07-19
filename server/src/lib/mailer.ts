import nodemailer from "nodemailer";
import fs from "node:fs";
import { getSetting, setSetting } from "../db.js";
import { config } from "../config.js";
import { decrypt, encrypt } from "./crypto.js";
import { resolveOutboundHost } from "./outbound.js";

/**
 * SMTP is configured in the settings table. Defaults target an unauthenticated
 * internal relay (host "relay", port 25) — the common homelab setup — but every
 * standard SMTP option is supported for public deployments. The password is
 * stored encrypted, like integration secrets.
 */

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean; // implicit TLS (465); STARTTLS is negotiated automatically otherwise
  allowInsecureTls: boolean;
  user: string;
  pass: string;
  from: string;
}

export function getSmtp(): SmtpConfig {
  let pass = "";
  const enc = getSetting("smtp_pass_enc", "");
  if (enc) {
    try {
      pass = decrypt(enc);
    } catch {
      /* key rotated — treat as empty */
    }
  }
  return {
    enabled: getSetting("smtp_enabled", "0") === "1",
    host: getSetting("smtp_host", "relay"),
    port: Number(getSetting("smtp_port", "25")) || 25,
    secure: getSetting("smtp_secure", "0") === "1",
    allowInsecureTls: getSetting("smtp_allow_insecure_tls", "0") === "1",
    user: getSetting("smtp_user", ""),
    pass,
    from: getSetting("smtp_from", "Harbor <harbor@localhost>"),
  };
}

export function saveSmtp(patch: Partial<SmtpConfig> & { pass?: string }): {
  credentialCleared: boolean;
} {
  const current = getSmtp();
  const nextIdentity = {
    host: patch.host?.trim().toLowerCase() ?? current.host.trim().toLowerCase(),
    port: patch.port ?? current.port,
    secure: patch.secure ?? current.secure,
    user: patch.user?.trim() ?? current.user,
  };
  const credentialCleared =
    !!current.pass &&
    (nextIdentity.host !== current.host.trim().toLowerCase() ||
      nextIdentity.port !== current.port ||
      nextIdentity.secure !== current.secure ||
      nextIdentity.user !== current.user);
  if (credentialCleared) setSetting("smtp_pass_enc", "");
  if (patch.enabled !== undefined) setSetting("smtp_enabled", patch.enabled ? "1" : "0");
  if (patch.host !== undefined) setSetting("smtp_host", patch.host.trim());
  if (patch.port !== undefined) setSetting("smtp_port", String(patch.port));
  if (patch.secure !== undefined) setSetting("smtp_secure", patch.secure ? "1" : "0");
  if (patch.allowInsecureTls !== undefined)
    setSetting("smtp_allow_insecure_tls", patch.allowInsecureTls ? "1" : "0");
  if (patch.user !== undefined) setSetting("smtp_user", patch.user.trim());
  if (patch.from !== undefined) setSetting("smtp_from", patch.from.trim());
  // only overwrite the stored password when a non-empty new value is provided
  if (patch.pass) setSetting("smtp_pass_enc", encrypt(patch.pass));
  return { credentialCleared: credentialCleared && !patch.pass };
}

async function transport(cfg: SmtpConfig) {
  const address = await resolveOutboundHost(cfg.host);
  let ca: Buffer | undefined;
  if (config.smtpCaFile) {
    const stat = fs.statSync(config.smtpCaFile);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("SMTP CA file must be a regular file at most 1 MiB");
    ca = fs.readFileSync(config.smtpCaFile);
  }
  return nodemailer.createTransport({
    host: address,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    tls: { rejectUnauthorized: !cfg.allowInsecureTls, servername: cfg.host, ...(ca ? { ca } : {}) },
  });
}

export function isolatedRecipients(to: string[]): string[] {
  return [...new Set(to.map((address) => address.trim().toLowerCase()).filter(Boolean))];
}

/** Send one message envelope per recipient so addresses are never disclosed. */
export async function sendMail(
  to: string[],
  subject: string,
  content: { text: string; html?: string }
): Promise<number> {
  const cfg = getSmtp();
  const recipients = isolatedRecipients(to);
  if (!cfg.enabled || recipients.length === 0) return 0;
  const sender = await transport(cfg);
  for (const recipient of recipients)
    await sender.sendMail({
      from: cfg.from,
      to: recipient,
      subject,
      text: content.text,
      html: content.html,
    });
  return recipients.length;
}

/** Verify connectivity + optionally send a themed test message to one address. */
export async function testSmtp(to?: string, siteTitle = "Harbor"): Promise<void> {
  const cfg = getSmtp();
  const t = await transport(cfg);
  await t.verify();
  if (to) {
    const { renderEmail } = await import("./emailTemplate.js");
    const { html, text } = renderEmail({
      kind: "success",
      title: "SMTP is working",
      body: "This is a test message from your Harbor. Fair winds.",
      fields: [
        { label: "Host", value: `${cfg.host}:${cfg.port}` },
        { label: "From", value: cfg.from },
      ],
      siteTitle,
    });
    await t.sendMail({ from: cfg.from, to, subject: `[${siteTitle}] Test message`, text, html });
  }
}
