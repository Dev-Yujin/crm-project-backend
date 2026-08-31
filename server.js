import http from 'http';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { expressMiddleware } from '@as-integrations/express5';
import userTypeDefs from './typedefs/userTypeDefs.js';
import userResolvers from './resolvers/userResolvers.js';
import memberTypeDefs from './typedefs/memberTypeDefs.js';
import memberResolvers from './resolvers/memberResolvers.js';
import clientTypeDefs from './typedefs/clientTypeDefs.js';
import clientResolvers from './resolvers/clientResolvers.js';
import taskTypeDefs from './typedefs/taskTypeDefs.js';
import taskResolvers from './resolvers/taskResolvers.js';
import departmentTypeDefs from './typedefs/departmentTypeDefs.js';
import departmentResolvers from './resolvers/departmentResolvers.js';
import serviceTypeDefs from './typedefs/serviceTypeDefs.js';
import serviceResolvers from './resolvers/serviceResolvers.js';
import recurringTaskTypeDefs from './typedefs/recurringTaskTypeDefs.js';
import recurringTaskResolvers from './resolvers/recurringTaskResolvers.js';
import taskStatusTypeDefs from './typedefs/taskStatusTypeDefs.js';
import taskStatusResolvers from './resolvers/taskStatusResolvers.js';
import groupTypeDefs from './typedefs/groupTypeDefs.js';
import groupResolvers from './resolvers/groupResolvers.js';
import emailCredentialsTypeDefs from './typedefs/emailCredentialsTypeDefs.js';
import emailCredentialsResolvers from './resolvers/emailCredentialsResolvers.js';
import billingTypeDefs from './typedefs/billingTypeDefs.js';
import billingResolvers from './resolvers/billingResolvers.js';
import billingLockPlugin from './utils/billingLockPlugin.js';
import { stripeWebhookHandler } from './routes/stripeWebhook.js';
import { fetchCurrentUser } from './models/userFunctions.js';
import { fetchUserGroupId } from './utils/groups.js';
import { fetchMemberFromToken } from './models/membersFunction.js';
import { MEMBER_COOKIE_NAME } from './utils/memberCookie.js';
import { createRequestSupabaseClient } from './utils/supabaseServerClient.js';
import { startScheduler } from './utils/scheduler.js';

const app = express();
const httpServer = http.createServer(app);

const server = new ApolloServer({
  typeDefs: [userTypeDefs, memberTypeDefs, clientTypeDefs, taskTypeDefs, departmentTypeDefs, serviceTypeDefs, recurringTaskTypeDefs, taskStatusTypeDefs, groupTypeDefs, emailCredentialsTypeDefs, billingTypeDefs],
  resolvers: [userResolvers, memberResolvers, clientResolvers, taskResolvers, departmentResolvers, serviceResolvers, recurringTaskResolvers, taskStatusResolvers, groupResolvers, emailCredentialsResolvers, billingResolvers],
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer }), billingLockPlugin],
});

async function main() {
  await server.start();
  startScheduler();

  // Auth resolves in this order:
  //   1. Supabase session cookie (the browser admin app) — via @supabase/ssr, which also
  //      transparently refreshes an expired access token using the cookie's refresh token
  //      and re-sets the cookies on this same response when it does.
  //   2. Member session cookie (the browser member portal).
  //   3. Authorization header bearer token (non-browser callers — scripts, tools). Accepts
  //      either a member token or a raw Supabase access token; the public API no longer
  //      hands either one to a browser to store, see loginMember/loginUser.
  const resolveContext = async (req, res) => {
    const supabase = createRequestSupabaseClient(req, res);
    const { data: { user: supabaseUser } } = await supabase.auth.getUser();

    if (supabaseUser) {
      try {
        const groupId = await fetchUserGroupId(supabaseUser.id);
        return { user: supabaseUser, groupId, member: null };
      } catch {
        // no group row yet — still authenticated, just ungated (requireGroup handles this)
        return { user: supabaseUser, groupId: null, member: null };
      }
    }

    const cookieToken = req.cookies?.[MEMBER_COOKIE_NAME] ?? null;

    if (cookieToken) {
      try {
        const member = await fetchMemberFromToken(cookieToken);
        return { user: null, groupId: null, member };
      } catch {
        // invalid/expired/revoked cookie — fall through and treat as unauthenticated
        // rather than also trying it as a Supabase token, since it came from the
        // member-cookie slot specifically
      }
    }

    const authHeader = req.headers.authorization ?? '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!accessToken) {
      return { user: null, groupId: null, member: null };
    }

    try {
      const member = await fetchMemberFromToken(accessToken);
      return { user: null, groupId: null, member };
    } catch {
      // not a valid member token — fall through and try it as a Supabase session
    }

    try {
      const user = await fetchCurrentUser(accessToken);
      const groupId = await fetchUserGroupId(user.id);
      return { user, groupId, member: null };
    } catch {
      return { user: null, groupId: null, member: null };
    }
  };

  const allowedOrigins = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const port = process.env.PORT ?? 4000;
  const backendUrl = process.env.PUBLIC_BACKEND_URL ?? `http://localhost:${port}`;
  const frontendUrl = allowedOrigins[0];

  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(cookieParser());

  // Google OAuth, mediated entirely server-side (PKCE) so the session is only ever handed to
  // the browser as an httpOnly cookie — the browser's own JS never sees an access/refresh
  // token or the OAuth code at any point. Requires this callback URL to be added to the
  // Supabase project's Authentication -> URL Configuration -> Redirect URLs allowlist; see
  // ADMIN_SESSION_SECURITY_INTEGRATION.md.
  app.get('/auth/google', async (req, res) => {
    const supabase = createRequestSupabaseClient(req, res);
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${backendUrl}/auth/google/callback` },
    });

    if (error || !data?.url) {
      return res.redirect(`${frontendUrl}/login?error=oauth_start_failed`);
    }

    res.redirect(data.url);
  });

  app.get('/auth/google/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : null;

    if (!code) {
      return res.redirect(`${frontendUrl}/login?error=oauth_no_code`);
    }

    const supabase = createRequestSupabaseClient(req, res);
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      return res.redirect(`${frontendUrl}/login?error=oauth_exchange_failed`);
    }

    res.redirect(`${frontendUrl}/app`);
  });

  // Stripe needs the exact raw request bytes to verify the signature — express.raw here,
  // NOT express.json(), and this must be registered before the app-wide express.json()
  // below or that would consume/reparse the body first.
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);

  app.use(
    express.json({ limit: '400kb' }),
    expressMiddleware(server, {
      context: async ({ req, res }) => ({ ...(await resolveContext(req, res)), res, req }),
    })
  );

  await new Promise((resolve) => httpServer.listen({ port }, resolve));
  console.log(`🚀 Server ready at http://localhost:${port}/`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
