const serviceTypeDefs = `#graphql
  type Service {
    id: ID!
    name: String!
    groupId: ID!
  }

  type Query {
    services(groupId: ID): [Service!]!
  }

  type Mutation {
    addService(name: String!): Service!
    updateService(serviceId: ID!, name: String!): Service!
    deleteService(serviceId: ID!): Service!
  }
`;

export default serviceTypeDefs;
