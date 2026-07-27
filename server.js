import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
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
import { startScheduler } from './utils/scheduler.js';


const server = new ApolloServer({
  typeDefs:[userTypeDefs, memberTypeDefs, clientTypeDefs, taskTypeDefs, departmentTypeDefs, serviceTypeDefs, recurringTaskTypeDefs, taskStatusTypeDefs, groupTypeDefs, emailCredentialsTypeDefs],
  resolvers:[userResolvers, memberResolvers, clientResolvers, taskResolvers, departmentResolvers, serviceResolvers, recurringTaskResolvers, taskStatusResolvers, groupResolvers, emailCredentialsResolvers],
});

startScheduler();

const { url } = await startStandaloneServer(server, {
  context: async ({ req }) => {
    const authHeader = req.headers.authorization ?? '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!accessToken) {
      return { user: null, groupId: null };
    }

    try {
      const user = await fetchCurrentUser(accessToken);
      const groupId = await fetchUserGroupId(user.id);
      return { user, groupId };
    } catch {
      return { user: null, groupId: null };
    }
  },
});
console.log(`🚀 Server ready at ${url}`);