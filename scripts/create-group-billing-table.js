// One-time setup: creates the group_billing table backing Stripe subscriptions (see
// docs/superpowers/specs/2026-08-30-stripe-billing-plans-design.md). Idempotent — safe
// to re-run; IF NOT EXISTS guards make a second run a no-op.
//
// Usage: node scripts/create-group-billing-table.js

import { pool } from "../config/supabase.js";

async function main() {
  console.log("Creating group_billing table (if missing)...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_billing (
      group_id uuid PRIMARY KEY,
      stripe_customer_id text UNIQUE,
      stripe_subscription_id text UNIQUE,
      plan text CHECK (plan IN ('starter', 'business', 'scale')),
      status text NOT NULL DEFAULT 'trialing'
        CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
      trial_ends_at timestamptz NOT NULL,
      current_period_end timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const check = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'group_billing'
  `);
  console.log(
    check.rows.length > 0
      ? "Done — group_billing table exists."
      : "Something went wrong — group_billing table was not found after creation.",
  );

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
