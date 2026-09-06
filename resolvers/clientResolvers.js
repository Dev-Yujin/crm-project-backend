import {
    getAllClients,
    addClient,
    deleteClient,
    editClient,
    clientInquiry,
} from '../models/clients.js';
import { requireGroup } from '../utils/requireUser.js';
import { fromStoredCustomFields } from '../models/customFields.js';

const mapClient = (row) => row && {
    id: row.id,
    clientName: row.clientName,
    businessName: row.businessName,
    email: row.email,
    whatsappNumber: row.whatsappNumber ?? null,
    clientNotes: row.clientNotes ?? null,
    servicesAvailed: row.servicesAvailed ?? null,
    groupId: row.groupId,
    createdAt: row.createdAt != null ? String(row.createdAt) : null,
    customFields: fromStoredCustomFields(row.customFields),
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
            const groupId = requireGroup(context);
            const clients = await getAllClients(groupId);
            return clients.map(mapClient);
        },
    },
    Mutation: {
        addClient: async (_, { clientName, businessName, email, whatsappNumber, clientNotes, servicesAvailed, customFields }, context) => {
            const groupId = requireGroup(context);
            const client = await addClient(clientName, businessName, email, whatsappNumber, clientNotes, servicesAvailed, groupId, customFields);
            return mapClient(client);
        },
        deleteClient: async (_, { clientId }, context) => {
            const groupId = requireGroup(context);
            const client = await deleteClient(clientId, groupId);
            return mapClient(client);
        },
        editClient: async (_, { clientId, ...updates }, context) => {
            const groupId = requireGroup(context);
            const client = await editClient(clientId, updates, groupId);
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
