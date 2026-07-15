import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import userTypeDefs from './typedefs/userTypeDefs.js';
import userResolvers from './resolvers/userResolvers.js';
import memberTypeDefs from './typedefs/memberTypeDefs.js';
import memberResolvers from './resolvers/memberResolvers.js';
import jobTypeDefs from './typedefs/jobTypeDefs.js';
import jobResolvers from './resolvers/jobResolvers.js';
import clientTypeDefs from './typedefs/clientTypeDefs.js';
import clientResolvers from './resolvers/clientResolvers.js';
import taskTypeDefs from './typedefs/taskTypeDefs.js';
import taskResolvers from './resolvers/taskResolvers.js';
import departmentTypeDefs from './typedefs/departmentTypeDefs.js';
import departmentResolvers from './resolvers/departmentResolvers.js';
import serviceTypeDefs from './typedefs/serviceTypeDefs.js';
import serviceResolvers from './resolvers/serviceResolvers.js';
import { fetchCurrentUser } from './models/userFunctions.js';


const server = new ApolloServer({
  typeDefs:[userTypeDefs, memberTypeDefs, jobTypeDefs, clientTypeDefs, taskTypeDefs, departmentTypeDefs, serviceTypeDefs],
  resolvers:[userResolvers, memberResolvers, jobResolvers, clientResolvers, taskResolvers, departmentResolvers, serviceResolvers],
});

const { url } = await startStandaloneServer(server, {
  context: async ({ req }) => {
    const authHeader = req.headers.authorization ?? '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!accessToken) {
      return { user: null };
    }

    try {
      const user = await fetchCurrentUser(accessToken);
      return { user };
    } catch {
      return { user: null };
    }
  },
});
console.log(`🚀 Server ready at ${url}`);