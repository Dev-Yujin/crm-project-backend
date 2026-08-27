import { getDatabase, ServerValue } from "firebase-admin/database";
import { app } from "../config/firebase.js";
import { pool } from "../config/supabase.js";
import { validateServicesExist } from "./services.js";

//Fetch all clients belonging to a group
export const getAllClients = async (groupId) => {
    try {
        const clientsSnapshot = await getDatabase(app).ref("clients").once("value");
        const clientsData = clientsSnapshot.val();
        const clients = clientsData ? Object.entries(clientsData).map(([id, client]) => ({ id, ...client })) : [];
        return clients.filter((client) => client.groupId === groupId);
    } catch (error) {
        console.error("Error fetching all clients:", error);
        throw error;
    }
};

//Add a new client to a group
export const addClient = async (clientName, businessName, email, whatsappNumber = null, clientNotes = null, servicesAvailed = null, groupId) => {
    try {
        await validateServicesExist(servicesAvailed, groupId);

        const clientsRef = getDatabase(app).ref("clients");
        const newClientRef = clientsRef.push();
        await newClientRef.set({
            clientName,
            businessName,
            email,
            whatsappNumber,
            clientNotes,
            servicesAvailed,
            groupId,
            createdAt: ServerValue.TIMESTAMP,
        });

        return { id: newClientRef.key, clientName, businessName, email, whatsappNumber, clientNotes, servicesAvailed, groupId };
    } catch (error) {
        console.error("Error adding client:", error);
        throw error;
    }
};

//Delete a client by their ID (must belong to the caller's group)
export const deleteClient = async (clientId, groupId) => {
    try {
        const clientRef = getDatabase(app).ref(`clients/${clientId}`);
        const clientSnapshot = await clientRef.once("value");

        if (!clientSnapshot.exists() || clientSnapshot.val().groupId !== groupId) {
            throw new Error("Client not found");
        }

        await clientRef.remove();
        return { id: clientId, ...clientSnapshot.val() };
    } catch (error) {
        console.error("Error deleting client:", error);
        throw error;
    }
};

//Edit a client's details by their ID (must belong to the caller's group)
export const editClient = async (clientId, { clientName, businessName, email, whatsappNumber, clientNotes, servicesAvailed } = {}, groupId) => {
    try {
        const clientRef = getDatabase(app).ref(`clients/${clientId}`);
        const clientSnapshot = await clientRef.once("value");

        if (!clientSnapshot.exists() || clientSnapshot.val().groupId !== groupId) {
            throw new Error("Client not found");
        }

        if (servicesAvailed !== undefined) {
            await validateServicesExist(servicesAvailed, groupId);
        }

        const updatedData = {};
        if (clientName !== undefined) updatedData.clientName = clientName;
        if (businessName !== undefined) updatedData.businessName = businessName;
        if (email !== undefined) updatedData.email = email;
        if (whatsappNumber !== undefined) updatedData.whatsappNumber = whatsappNumber;
        if (clientNotes !== undefined) updatedData.clientNotes = clientNotes;
        if (servicesAvailed !== undefined) updatedData.servicesAvailed = servicesAvailed;
        const finalData = { ...clientSnapshot.val(), ...updatedData };
        await clientRef.set(finalData);
        return { id: clientId, ...finalData };
    } catch (error) {
        console.error("Error editing client:", error);
        throw error;
    }
};

//client inquiry function (a client sends an inquiry to the business) — not scoped by group, public contact form
export const clientInquiry = async (clientName, email, message) => {
    try {
        const inquiriesRef = getDatabase(app).ref("inquiries");
        const newInquiryRef = inquiriesRef.push();
        await newInquiryRef.set({
            clientName,
            email,
            message,
            createdAt: ServerValue.TIMESTAMP,
        });

        return { id: newInquiryRef.key, clientName, email, message };
    } catch (error) {
        console.error("Error sending client inquiry:", error);
        throw error;
    }
};
