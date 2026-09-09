import { Resend } from "resend";
import { buildMemberInviteEmail } from "./emailTemplates.js";

const resend = new Resend(process.env.RESEND_API_KEY);

//Sends a member invite email (portal link + login credentials) from the CRM's shared
//sender address via Resend — no per-user credentials needed.
export const sendMemberInviteEmail = async ({ toEmail, memberUsername, memberPassword }) => {
    const portalUrl = process.env.MEMBER_PORTAL_URL;
    const { subject, html, text } = buildMemberInviteEmail({
        toEmail,
        memberUsername,
        memberPassword,
        portalUrl,
    });

    const { error } = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL,
        to: toEmail,
        subject,
        text,
        html,
    });

    if (error) {
        throw new Error(error.message ?? "Resend failed to send the invite email.");
    }
};
