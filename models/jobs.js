import { getDatabase, ref, push, set, get, remove, serverTimestamp } from "firebase/database";
import { app } from "../config/firebase.js";
import { pool } from "../config/supabase.js";

//Add a Job, and assign members (from the Postgres members table) to that Job
const db = getDatabase(app);

//Add job function
export const addJob = async (title) => {
    try {
        const jobsRef = ref(db, "jobs");
        const newJobRef = push(jobsRef);
        await set(newJobRef, {
            title,
            createdAt: serverTimestamp(),
        });

        return { id: newJobRef.key, title };
    } catch (error) {
        console.error("Error adding job:", error);
        throw error;
    }
};

//Add a member (by their members.uuid) under a job
export const addMemberToJob = async (jobId, memberUuid) => {
    try {
        const jobRef = ref(db, `jobs/${jobId}`);
        const jobSnapshot = await get(jobRef);

        if (!jobSnapshot.exists()) {
            throw new Error("Job not found");
        }

        const memberQuery = "SELECT uuid, username, email FROM members WHERE uuid = $1";
        const result = await pool.query(memberQuery, [memberUuid]);

        if (result.rows.length === 0) {
            throw new Error("Member not found");
        }

        const member = result.rows[0];
        const memberRef = ref(db, `jobs/${jobId}/members/${memberUuid}`);
        await set(memberRef, {
            username: member.username,
            email: member.email,
            assignedAt: serverTimestamp(),
        });

        return { jobId, uuid: member.uuid, username: member.username, email: member.email };
    } catch (error) {
        console.error("Error adding member to job:", error);
        throw error;
    }
};

//Fetch all jobs, along with their assigned members
export const getAllJobs = async () => {
    try {
        const jobsSnapshot = await get(ref(db, "jobs"));

        if (!jobsSnapshot.exists()) {
            return [];
        }

        return Object.entries(jobsSnapshot.val()).map(([id, job]) => ({
            id,
            title: job.title,
            createdAt: job.createdAt,
            members: Object.entries(job.members ?? {}).map(([uuid, member]) => ({
                uuid,
                username: member.username,
                email: member.email,
                assignedAt: member.assignedAt,
            })),
        }));
    } catch (error) {
        console.error("Error fetching jobs:", error);
        throw error;
    }
};

//Remove a member from a job
export const removeMemberFromJob = async (jobId, memberUuid) => {
    try {
        const memberRef = ref(db, `jobs/${jobId}/members/${memberUuid}`);
        const memberSnapshot = await get(memberRef);

        if (!memberSnapshot.exists()) {
            throw new Error("Member is not assigned to this job");
        }

        await remove(memberRef);
        return true;
    } catch (error) {
        console.error("Error removing member from job:", error);
        throw error;
    }
};
