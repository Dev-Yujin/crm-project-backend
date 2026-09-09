// Continuum's coral/terracotta brand palette, resolved from the frontend's oklch
// tokens (crm-frontend/src/index.css) to hex — email clients don't render oklch().
const BRAND = {
    accent500: "#e75347",
    accent600: "#d33c33",
    accent700: "#af2b25",
    accent800: "#89221c",
    ink: "#1b1412",
    muted: "#5e5653",
    surface: "#fdfbfa",
    surfaceMuted: "#f9f4f0",
    line: "#ddd6d2",
};

const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[char]);

// The brand mark redrawn as table cells instead of the app's inline SVG — email
// clients (especially Outlook desktop) don't reliably render inline <svg>, and an
// <img> would break under image-blocking. Same geometry as LogoGlyph.tsx: three
// bars of increasing length/opacity, staggered rightward.
const logoMarkHtml = () => `
<table role="presentation" width="44" height="44" cellpadding="0" cellspacing="0" border="0" style="width:44px;height:44px;background-color:${BRAND.accent600};border-radius:10px;">
  <tr>
    <td style="padding:14px 10px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="height:4px;width:10px;background-color:#ffffff;opacity:0.55;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="height:4px;line-height:4px;font-size:4px;">&nbsp;</td></tr>
        <tr><td style="height:4px;width:16px;background-color:#ffffff;opacity:0.78;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="height:4px;line-height:4px;font-size:4px;">&nbsp;</td></tr>
        <tr><td style="height:4px;width:20px;background-color:#ffffff;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
    </td>
  </tr>
</table>`;

// A bulletproof (table-based) button — renders consistently in Outlook desktop,
// which ignores <a> padding/border-radius from CSS.
const buttonHtml = (href, label) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="border-radius:10px;background-color:${BRAND.accent600};">
      <a href="${href}" style="display:inline-block;padding:13px 28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14.5px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">
        ${escapeHtml(label)}
      </a>
    </td>
  </tr>
</table>`;

const credentialRow = (label, value, isLast = false) => `
<tr>
  <td style="padding:10px 0;${isLast ? "" : `border-bottom:1px solid ${BRAND.line};`}">
    <span style="display:block;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11.5px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:${BRAND.muted};">${escapeHtml(label)}</span>
    <span style="display:block;margin-top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;color:${BRAND.ink};word-break:break-all;">${escapeHtml(value)}</span>
  </td>
</tr>`;

export const buildMemberInviteEmail = ({ toEmail, memberUsername, memberPassword, portalUrl }) => {
    const subject = "You've been added as a member";

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${BRAND.surfaceMuted};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.surfaceMuted};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${BRAND.line};">

            <!-- Header: brand mark + wordmark -->
            <tr>
              <td style="padding:28px 32px;border-bottom:1px solid ${BRAND.line};">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding-right:12px;">${logoMarkHtml()}</td>
                    <td style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:${BRAND.ink};">
                      Continuum
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Hero -->
            <tr>
              <td style="padding:40px 32px;background-color:${BRAND.accent600};">
                <p style="margin:0 0 6px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:rgba(255,255,255,0.75);">
                  Member invite
                </p>
                <h1 style="margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:26px;line-height:1.3;font-weight:700;color:#ffffff;">
                  You've been added as a member
                </h1>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${BRAND.ink};">
                  Someone on your team just gave you access to their Continuum workspace. Use the
                  credentials below to sign in to the member portal.
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.surfaceMuted};border:1px solid ${BRAND.line};border-radius:12px;padding:18px 20px;">
                  ${credentialRow("Username", memberUsername)}
                  ${credentialRow("Email", toEmail)}
                  ${credentialRow("Password", memberPassword, true)}
                </table>

                <div style="margin-top:28px;">
                  ${buttonHtml(portalUrl, "Sign in to your portal")}
                </div>

                <p style="margin:24px 0 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.6;color:${BRAND.muted};">
                  Keep this password safe — treat it like any other login. If you weren't
                  expecting this invite, you can ignore this email.
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:20px 32px;background-color:${BRAND.surfaceMuted};border-top:1px solid ${BRAND.line};">
                <p style="margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:${BRAND.muted};">
                  Sent by Continuum CRM &middot; <a href="${portalUrl}" style="color:${BRAND.muted};">${portalUrl}</a>
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

    const text = `You've been added as a member.

Portal: ${portalUrl}
Username: ${memberUsername}
Email: ${toEmail}
Password: ${memberPassword}

Please keep these credentials safe.`;

    return { subject, html, text };
};
