import {
    addJob,
    addMemberToJob,
    getAllJobs,
    removeMemberFromJob,
} from '../models/jobs.js';
import { requireUser } from '../utils/requireUser.js';

const mapJob = (job) => ({
    id: job.id,
    title: job.title,
    createdAt: job.createdAt != null ? String(job.createdAt) : null,
    members: (job.members ?? []).map(mapJobMember),
});

const mapJobMember = (member) => ({
    uuid: member.uuid,
    username: member.username,
    email: member.email,
    assignedAt: member.assignedAt != null ? String(member.assignedAt) : null,
});

const jobResolvers = {
    Query: {
        jobs: async () => {
            const jobs = await getAllJobs();
            return jobs.map(mapJob);
        },
    },
    Mutation: {
        addJob: async (_, { title }, context) => {
            requireUser(context);
            const job = await addJob(title);
            return mapJob(job);
        },
        addMemberToJob: async (_, { jobId, memberUuid }, context) => {
            requireUser(context);
            const member = await addMemberToJob(jobId, memberUuid);
            return mapJobMember(member);
        },
        removeMemberFromJob: async (_, { jobId, memberUuid }, context) => {
            requireUser(context);
            return removeMemberFromJob(jobId, memberUuid);
        },
    },
};

export default jobResolvers;
