import {
    getAllRecurringTasks,
    addRecurringTask,
    deleteRecurringTask,
    pauseRecurringTask,
    resumeRecurringTask,
} from '../models/recurringTasks.js';
import { requireUser } from '../utils/requireUser.js';

const mapRecurringTask = (template) => template && {
    id: template.id,
    clientId: template.clientId,
    clientName: template.clientName,
    taskName: template.taskName,
    taskDescription: template.taskDescription,
    serviceId: template.serviceId,
    assignedMembers: template.assignedMembers ?? [],
    priority: template.priority,
    recurrence: template.recurrence,
    createdBy: template.createdBy ?? null,
    active: template.active,
    lastRunAt: template.lastRunAt != null ? String(template.lastRunAt) : null,
    nextRunAt: template.nextRunAt != null ? String(template.nextRunAt) : null,
};

const recurringTaskResolvers = {
    Query: {
        recurringTasks: async (_, __, context) => {
            requireUser(context);
            const templates = await getAllRecurringTasks();
            return templates.map(mapRecurringTask);
        },
    },
    Mutation: {
        addRecurringTask: async (_, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, recurrence, priority }, context) => {
            const user = requireUser(context);
            const template = await addRecurringTask(clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, user.id, recurrence, priority);
            return mapRecurringTask(template);
        },
        deleteRecurringTask: async (_, { recurringTaskId }, context) => {
            requireUser(context);
            return deleteRecurringTask(recurringTaskId);
        },
        pauseRecurringTask: async (_, { recurringTaskId }, context) => {
            requireUser(context);
            const template = await pauseRecurringTask(recurringTaskId);
            return mapRecurringTask(template);
        },
        resumeRecurringTask: async (_, { recurringTaskId }, context) => {
            requireUser(context);
            const template = await resumeRecurringTask(recurringTaskId);
            return mapRecurringTask(template);
        },
    },
};

export default recurringTaskResolvers;
