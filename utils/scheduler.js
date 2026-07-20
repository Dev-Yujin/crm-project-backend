import cron from 'node-cron';
import { runDueRecurringTasks } from '../models/recurringTasks.js';

//Ticks hourly, checking every active recurring task template for a due run
export function startScheduler() {
    cron.schedule('0 * * * *', async () => {
        try {
            const generated = await runDueRecurringTasks();
            if (generated.length > 0) {
                console.log(`Recurring task scheduler: generated ${generated.length} task(s)`);
            }
        } catch (error) {
            console.error('Recurring task scheduler tick failed:', error);
        }
    });
}
