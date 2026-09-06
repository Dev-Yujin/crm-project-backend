const clientTypeDefs = `#graphql
  type Client {
    id: ID!
    clientName: String!
    businessName: String!
    email: String!
    whatsappNumber: String
    clientNotes: String
    servicesAvailed: [ID!]
    groupId: ID!
    createdAt: String
    customFields: [CustomFieldValue!]!
  }

  type Inquiry {
    id: ID!
    clientName: String!
    email: String!
    message: String!
  }

  type Query {
    clients: [Client!]!
  }

  type Mutation {
    addClient(
      clientName: String!
      businessName: String!
      email: String!
      whatsappNumber: String
      clientNotes: String
      servicesAvailed: [ID!]
      customFields: [CustomFieldValueInput!]
    ): Client!
    deleteClient(clientId: ID!): Client!
    editClient(
      clientId: ID!
      clientName: String
      businessName: String
      email: String
      whatsappNumber: String
      clientNotes: String
      servicesAvailed: [ID!]
      customFields: [CustomFieldValueInput!]
    ): Client!
    clientInquiry(clientName: String!, email: String!, message: String!): Inquiry!
  }
`;

export default clientTypeDefs;
