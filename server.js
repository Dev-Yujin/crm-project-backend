import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import userTypeDefs from './typedefs/userTypeDefs.js';
import userResolvers from './resolvers/userResolvers.js';


const server = new ApolloServer({
  typeDefs:[userTypeDefs],
  resolvers:[userResolvers],
});

const { url } = await startStandaloneServer(server);
console.log(`🚀 Server ready at ${url}`);