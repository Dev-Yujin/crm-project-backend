import {
    getAllTaskStatuses,
    addTaskStatus,
    updateTaskStatus,
    deleteTaskStatus,
} from '../models/taskStatuses.js';
import { requireGroup, resolveGroupId } from '../utils/requireUser.js';

const taskStatusResolvers = {
    Query: {
        taskStatuses: async (_, { groupId }, context) => {
            return getAllTaskStatuses(resolveGroupId(context, groupId));
        },
    },
    Mutation: {
        addTaskStatus: async (_, { name }, context) => {
            const groupId = requireGroup(context);
            return addTaskStatus(name, groupId);
        },
        updateTaskStatus: async (_, { taskStatusId, name }, context) => {
            const groupId = requireGroup(context);
            return updateTaskStatus(taskStatusId, name, groupId);
        },
        deleteTaskStatus: async (_, { taskStatusId }, context) => {
            const groupId = requireGroup(context);
            return deleteTaskStatus(taskStatusId, groupId);
        },
    },
};

export default taskStatusResolvers;
