import { upsertEmailCredentials, getMyEmailCredentialsInfo } from '../models/emailCredentials.js';
import { requireUser } from '../utils/requireUser.js';

const mapEmailCredentials = (row) => row && {
    email: row.email,
    updatedAt: row.updatedAt != null ? new Date(row.updatedAt).toISOString() : null,
};

const emailCredentialsResolvers = {
    Query: {
        myEmailCredentials: async (_, __, context) => {
            const user = requireUser(context);
            const credentials = await getMyEmailCredentialsInfo(user.id);
            return mapEmailCredentials(credentials);
        },
    },
    Mutation: {
        updateEmailCredentials: async (_, { email, appPassword }, context) => {
            const user = requireUser(context);
            const credentials = await upsertEmailCredentials(user.id, email, appPassword);
            return mapEmailCredentials(credentials);
        },
    },
};

export default emailCredentialsResolvers;
