/**
 * Email service — thin wrapper around Resend's REST API.
 *
 * Why a wrapper rather than the resend SDK:
 *   The SDK pulls a non-trivial dependency tree for one HTTP POST. Calling
 *   the REST endpoint directly keeps the build lean and decouples us from
 *   the SDK's release cadence. The contract is one-shot transactional
 *   email, no batching/templates needed at this scale.
 *
 * Dev mode:
 *   When RESEND_API_KEY is unset the service logs the message instead of
 *   sending. Local devs don't need an API key to exercise the invite flow;
 *   the link prints to the API console.
 *
 * Privacy:
 *   The email body is rendered inside this process — Resend stores only
 *   delivery metadata (recipient, timestamp, message id), not the cleartext
 *   token. PII surface is the recipient address itself. See
 *   docs/governance/PRIVACY.md "Subprocessors → Resend".
 */
import { getEnv } from '../../config/env.js';
import { getLogger } from '../../config/logger.js';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  delivered: boolean;
  providerId?: string;
  // True when no provider was configured and the email was logged instead.
  loggedOnly?: boolean;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const env = getEnv();
  const log = getLogger();

  if (!env.RESEND_API_KEY) {
    log.warn(
      { to: input.to, subject: input.subject },
      'email.dev.no-provider — printing body to console',
    );
    // eslint-disable-next-line no-console
    console.log('───── DEV EMAIL ─────');
    // eslint-disable-next-line no-console
    console.log(`To:      ${input.to}`);
    // eslint-disable-next-line no-console
    console.log(`From:    ${env.MAIL_FROM}`);
    // eslint-disable-next-line no-console
    console.log(`Subject: ${input.subject}`);
    // eslint-disable-next-line no-console
    console.log('---');
    // eslint-disable-next-line no-console
    console.log(input.text);
    // eslint-disable-next-line no-console
    console.log('─────────────────────');
    return { delivered: true, loggedOnly: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '<unreadable>');
    log.error({ status: res.status, detail, to: input.to }, 'email.resend.failed');
    throw new Error(`Resend API ${res.status}: ${detail}`);
  }

  const json = (await res.json().catch(() => ({}))) as { id?: string };
  log.info({ to: input.to, providerId: json.id }, 'email.sent');
  return { delivered: true, providerId: json.id };
}
