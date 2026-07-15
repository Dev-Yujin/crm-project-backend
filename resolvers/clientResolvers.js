import {
    getAllClients,
    addClient,
    deleteClient,
    editClient,
    clientInquiry,
} from '../models/clients.js';
import { requireUser } from '../utils/requireUser.js';

const mapClient = (row) => row && {
    id: row.id,
    clientName: row.clientName,
    businessName: row.businessName,
    email: row.email,
    whatsappNumber: row.whatsappNumber ?? null,
    clientNotes: row.clientNotes ?? null,
    servicesAvailed: row.servicesAvailed ?? null,
    createdAt: row.createdAt != null ? String(row.createdAt) : null,
};

const mapInquiry = (row) => row && {
    id: row.id,
    clientName: row.clientName,
    email: row.email,
    message: row.message,
};

const clientResolvers = {
    Query: {
        clients: async (_, __, context) => {
            requireUser(context);
            const clients = await getAllClients();
            return clients.map(mapClient);
        },
    },
    Mutation: {
        addClient: async (_, { clientName, businessName, email, whatsappNumber, clientNotes, servicesAvailed }, context) => {
            requireUser(context);
            const client = await addClient(clientName, businessName, email, whatsappNumber, clientNotes, servicesAvailed);
            return mapClient(client);
        },
        deleteClient: async (_, { clientId }, context) => {
            requireUser(context);
            const client = await deleteClient(clientId);
            return mapClient(client);
        },
        editClient: async (_, { clientId, ...updates }, context) => {
            requireUser(context);
            const client = await editClient(clientId, updates);
            return mapClient(client);
        },
        // Public: submitted by a client with no account, not a "user" or "member"
        clientInquiry: async (_, { clientName, email, message }) => {
            const inquiry = await clientInquiry(clientName, email, message);
            return mapInquiry(inquiry);
        },
    },
};

export default clientResolvers;
