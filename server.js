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
import { fetchCurrentUser } from './models/userFunctions.js';
import { fetchUserGroupId } from './utils/groups.js';
import { fetchMemberFromToken } from './models/membersFunction.js';
import { MEMBER_COOKIE_NAME } from './utils/memberCookie.js';
import { startScheduler } from './utils/scheduler.js';

const app = express();
const httpServer = http.createServer(app);

const server = new ApolloServer({
  typeDefs: [userTypeDefs, memberTypeDefs, clientTypeDefs, taskTypeDefs, departmentTypeDefs, serviceTypeDefs, recurringTaskTypeDefs, taskStatusTypeDefs, groupTypeDefs, emailCredentialsTypeDefs],
  resolvers: [userResolvers, memberResolvers, clientResolvers, taskResolvers, departmentResolvers, serviceResolvers, recurringTaskResolvers, taskStatusResolvers, groupResolvers, emailCredentialsResolvers],
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
});

await server.start();
startScheduler();

// Member auth resolves in this order: httpOnly cookie (the browser member portal) first,
// then an Authorization header bearer token (non-browser callers — scripts, tools; the
// public API no longer hands out a raw token for browsers to store, see loginMember).
const resolveContext = async (req) => {
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

app.use(
  cors({ origin: allowedOrigins, credentials: true }),
  express.json(),
  cookieParser(),
  expressMiddleware(server, {
    context: async ({ req, res }) => ({ ...(await resolveContext(req)), res }),
  })
);

const port = process.env.PORT ?? 4000;
await new Promise((resolve) => httpServer.listen({ port }, resolve));
console.log(`🚀 Server ready at http://localhost:${port}/`);
