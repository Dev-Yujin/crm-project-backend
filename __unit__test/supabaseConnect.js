import { pool } from '../config/supabase.js';

// Test the database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error connecting to the database:', err);
  } else {
    console.log('Database connection successful. Current time:', res.rows[0].now);
  }
  pool.end(); // Close the connection after the test
});