import pg from 'pg';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { Pool } = pg;

if (!process.env.SUPABASE_URL) {
  throw new Error('Missing SUPABASE_URL environment variable');
}

if (!process.env.SUPABASE_PROJECT_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error('Missing SUPABASE_PROJECT_URL or SUPABASE_ANON_KEY environment variable');
}

// Direct Postgres pool, for querying tables (via the connection pooler)
export const pool = new Pool({
  connectionString: process.env.SUPABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Supabase client', err);
});

// Supabase Auth client (GoTrue), for signUp/signIn/OAuth (e.g. Google)
export const supabaseAuth = createClient(
  process.env.SUPABASE_PROJECT_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export default pool;
