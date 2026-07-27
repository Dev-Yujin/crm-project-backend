import nodemailer from "nodemailer";

//Sends a member invite email (portal link + login credentials) via the inviting user's own
//Gmail account. `gmailAppPassword` must be a Gmail App Password, not the account's normal password
//(Gmail's SMTP rejects normal passwords for third-party apps like this one).
export const sendMemberInviteEmail = async ({ gmailUser, gmailAppPassword, toEmail, memberUsername, memberPassword }) => {
    const portalUrl = process.env.MEMBER_PORTAL_URL;

    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailUser, pass: gmailAppPassword },
    });

    await transporter.sendMail({
        from: gmailUser,
        to: toEmail,
        subject: "You've been added as a member",
        text: `You've been added as a member.\n\nPortal: ${portalUrl}\nUsername: ${memberUsername}\nEmail: ${toEmail}\nPassword: ${memberPassword}\n\nPlease keep these credentials safe.`,
        html: `
            <p>You've been added as a member.</p>
            <p><strong>Portal:</strong> <a href="${portalUrl}">${portalUrl}</a></p>
            <p><strong>Username:</strong> ${memberUsername}<br/>
            <strong>Email:</strong> ${toEmail}<br/>
            <strong>Password:</strong> ${memberPassword}</p>
            <p>Please keep these credentials safe.</p>
        `,
    });
};
