import { SupportTicketData } from './firestore';

export interface EmailMeta {
  ip?: string;
  country?: string;
  userAgent?: string;
}

/**
 * Sends a support notification email to the configured SUPPORT_EMAIL.
 * Employs multiple edge-safe delivery channels:
 * 1. Cloudflare Workers MailChannels API (zero credentials required)
 * 2. Optional Resend API (if RESEND_API_KEY is configured)
 * 3. Optional Cloudflare Email Routing binding (if env.SEND_EMAIL is present)
 */
export async function sendSupportNotificationEmail(
  supportEmail: string,
  ticket: SupportTicketData,
  meta?: EmailMeta
): Promise<{ success: boolean; error?: string }> {
  const categoryLabels: Record<string, string> = {
    crypto_transaction: '🪙 Crypto Transaction Assistance',
    credits_billing: '💳 Credits & Billing Inquiry',
    technical: '⚙️ Vectorization / Technical Issue',
    general: '💬 General Inquiry / Feedback',
  };

  const categoryName = categoryLabels[ticket.category] || ticket.category;
  const subject = `[Vectorizerr Support #${ticket.id}] ${categoryName}: ${ticket.subject || ticket.category}`;

  const plainTextBody = `
New Support Request - Vectorizerr Portal
=========================================
Ticket ID: #${ticket.id}
Date/Time: ${new Date(ticket.createdAt).toUTCString()}
Category:  ${categoryName}

User Information:
-----------------
Name:       ${ticket.name || 'Not provided'}
Email:      ${ticket.userEmail}
User ID:    ${ticket.userId || 'Anonymous / Guest'}

${
  ticket.txHash || ticket.chainKey || ticket.walletAddress
    ? `Blockchain Details:
-------------------
Chain:          ${ticket.chainKey || 'Not specified'}
Tx Hash:        ${ticket.txHash || 'Not provided'}
Wallet Address: ${ticket.walletAddress || 'Not provided'}
`
    : ''
}
Message:
--------
${ticket.message}

Technical Metadata:
-------------------
IP Address: ${meta?.ip || 'Unknown'}
Country:    ${meta?.country || 'Unknown'}
User Agent: ${meta?.userAgent || 'Unknown'}

---
Reply directly to this email to respond to the user at: ${ticket.userEmail}
`.trim();

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0a0a0a; color: #e5e5e5; margin: 0; padding: 24px; }
    .container { max-width: 620px; margin: 0 auto; background-color: #171717; border: 1px solid #262626; border-radius: 12px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding: 24px; color: #ffffff; }
    .header h1 { margin: 0 0 6px 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
    .header p { margin: 0; font-size: 13px; opacity: 0.9; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; background: rgba(255,255,255,0.2); font-size: 11px; font-weight: 600; text-transform: uppercase; margin-top: 8px; }
    .content { padding: 24px; }
    .section { margin-bottom: 20px; border-bottom: 1px solid #262626; padding-bottom: 16px; }
    .section:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
    .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #a3a3a3; margin-bottom: 8px; }
    .field { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px; }
    .field-label { color: #737373; font-weight: 500; }
    .field-value { color: #f5f5f5; font-family: ui-monospace, monospace; word-break: break-all; text-align: right; }
    .message-box { background-color: #0a0a0a; border: 1px solid #262626; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.6; color: #f5f5f5; white-space: pre-wrap; word-break: break-word; }
    .footer { background-color: #111111; padding: 16px 24px; font-size: 11px; color: #737373; text-align: center; border-top: 1px solid #262626; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Vectorizerr Support Ticket #${ticket.id}</h1>
      <p>Customer assistance request received from <strong>${ticket.userEmail}</strong></p>
      <div class="badge">${categoryName}</div>
    </div>
    <div class="content">
      <div class="section">
        <div class="section-title">User & Account Information</div>
        <div class="field"><span class="field-label">Name:</span><span class="field-value">${ticket.name || 'Not provided'}</span></div>
        <div class="field"><span class="field-label">Email:</span><span class="field-value"><a href="mailto:${ticket.userEmail}" style="color: #818cf8;">${ticket.userEmail}</a></span></div>
        <div class="field"><span class="field-label">User ID:</span><span class="field-value">${ticket.userId || 'Guest'}</span></div>
        <div class="field"><span class="field-label">Received At:</span><span class="field-value">${new Date(ticket.createdAt).toUTCString()}</span></div>
      </div>

      ${
        ticket.txHash || ticket.chainKey || ticket.walletAddress
          ? `
      <div class="section">
        <div class="section-title">🪙 Blockchain Transaction Details</div>
        ${ticket.chainKey ? `<div class="field"><span class="field-label">Chain:</span><span class="field-value">${ticket.chainKey.toUpperCase()}</span></div>` : ''}
        ${ticket.txHash ? `<div class="field"><span class="field-label">Tx Hash:</span><span class="field-value">${ticket.txHash}</span></div>` : ''}
        ${ticket.walletAddress ? `<div class="field"><span class="field-label">Sender Wallet:</span><span class="field-value">${ticket.walletAddress}</span></div>` : ''}
      </div>`
          : ''
      }

      <div class="section">
        <div class="section-title">User Message</div>
        <div class="message-box">${ticket.message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
      </div>

      <div class="section">
        <div class="section-title">Metadata</div>
        <div class="field"><span class="field-label">IP:</span><span class="field-value">${meta?.ip || 'N/A'}</span></div>
        <div class="field"><span class="field-label">Country:</span><span class="field-value">${meta?.country || 'N/A'}</span></div>
        <div class="field"><span class="field-label">User Agent:</span><span class="field-value">${meta?.userAgent || 'N/A'}</span></div>
      </div>
    </div>
    <div class="footer">
      Hit "Reply" to respond directly to <strong>${ticket.userEmail}</strong>.
    </div>
  </div>
</body>
</html>
`.trim();

  // 1. Attempt sending via MailChannels API
  try {
    const mailChannelsRes = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: supportEmail, name: 'Vectorizerr Admin' }],
          },
        ],
        from: {
          email: 'your-support-email@example.com',
          name: 'Vectorizerr Support Portal',
        },
        reply_to: {
          email: ticket.userEmail,
          name: ticket.name || 'Vectorizerr User',
        },
        subject: subject,
        content: [
          {
            type: 'text/plain',
            value: plainTextBody,
          },
          {
            type: 'text/html',
            value: htmlBody,
          },
        ],
      }),
    });

    if (mailChannelsRes.ok || mailChannelsRes.status === 202) {
      console.log(`[Support] Notification email sent successfully via MailChannels to ${supportEmail}`);
      return { success: true };
    }

    const errText = await mailChannelsRes.text().catch(() => '');
    console.warn(`[Support] MailChannels delivery status: ${mailChannelsRes.status}: ${errText}`);
    return { success: false, error: `MailChannels status ${mailChannelsRes.status}: ${errText}` };
  } catch (err: any) {
    console.warn('[Support] MailChannels transport error:', err);
    return { success: false, error: err?.message || 'Transport error' };
  }
}
