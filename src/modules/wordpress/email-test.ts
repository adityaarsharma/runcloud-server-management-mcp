/**
 * email-test.ts — Test outbound email + diagnose SMTP / MTA setup
 *
 * Sends a test message via wp_mail() to a target address and reports the
 * result. Also detects whether an SMTP plugin is configured (WP Mail SMTP,
 * Post SMTP, FluentSMTP) vs the unreliable PHP mail() fallback.
 *
 * WP-CLI used:  wp eval wp_mail(...)  /  wp plugin list
 */

import { SSHOptions, sshExec, wpCli } from '../../core/ssh-enhanced.js';

export interface EmailTestResult {
  to: string;
  sent: boolean;
  smtpProvider: 'wp-mail-smtp' | 'post-smtp' | 'fluent-smtp' | 'mailpoet' | 'sendgrid' | 'php-mail' | 'unknown';
  rawOutput: string;
  recommendations: string[];
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

function validateEmail(s: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error('invalid email address');
}

const SMTP_PLUGINS = [
  { slug: 'wp-mail-smtp', provider: 'wp-mail-smtp' as const },
  { slug: 'post-smtp', provider: 'post-smtp' as const },
  { slug: 'fluent-smtp', provider: 'fluent-smtp' as const },
  { slug: 'mailpoet', provider: 'mailpoet' as const },
  { slug: 'sendgrid-email-delivery-simplified', provider: 'sendgrid' as const },
];

export async function testEmail(
  sshOpts: SSHOptions, wpPath: string, wpUser: string, to: string, subject = 'Perch test',
): Promise<EmailTestResult> {
  safe(wpPath);
  validateEmail(to);
  const recommendations: string[] = [];

  // Detect installed SMTP plugin
  const list = await wpCli(
    sshOpts, wpPath, wpUser,
    `plugin list --format=json --fields=name,status 2>/dev/null`,
  );
  let smtpProvider: EmailTestResult['smtpProvider'] = 'php-mail';
  try {
    const plugins = JSON.parse(list.stdout) as Array<{ name: string; status: string }>;
    for (const p of plugins) {
      if (p.status !== 'active') continue;
      const found = SMTP_PLUGINS.find(s => p.name === s.slug);
      if (found) {
        smtpProvider = found.provider;
        break;
      }
    }
  } catch { /* fall through */ }

  if (smtpProvider === 'php-mail') {
    recommendations.push(
      'No SMTP plugin detected. WordPress is using PHP mail() which most VPS providers (including RunCloud) rate-limit or block — install WP Mail SMTP or Fluent SMTP.',
    );
  }

  // Send test email
  const escSubj = subject.replace(/'/g, "''");
  const escTo = to.replace(/'/g, "''");
  const r = await wpCli(
    sshOpts, wpPath, wpUser,
    `eval "echo wp_mail('${escTo}', '${escSubj}', 'Perch test message — sent at ' . date('c')) ? 'OK' : 'FAIL';" 2>&1`,
  );
  const sent = /^OK\s*$/m.test(r.stdout);

  if (!sent) {
    recommendations.push(
      'wp_mail() returned false. Check the active SMTP plugin\'s log for the error (auth, port, sender domain). ' +
      'Verify SPF + DKIM DNS records for the sending domain.',
    );
  }

  return {
    to,
    sent,
    smtpProvider,
    rawOutput: (r.stdout + r.stderr).slice(0, 500),
    recommendations,
  };
}
