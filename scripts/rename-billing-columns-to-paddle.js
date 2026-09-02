// One-time migration: renames group_billing's Stripe-era columns to their Paddle
// equivalents. Safe to re-run — the column-existence check makes a second run a no-op.
// There is no live subscriber data to preserve (confirmed pre-migration), so this is a
// plain rename, not a backfill.
//
// Usage: node scripts/rename-billing-columns-to-paddle.js

import { pool } from "../config/supabase.js";

async function columnExists(column) {
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'group_billing' AND column_name = $1`,
    [column],
  );
  return result.rows.length > 0;
}

async function main() {
  console.log("Renaming group_billing's Stripe columns to Paddle...");

  if (await columnExists("stripe_customer_id")) {
    await pool.query("ALTER TABLE group_billing RENAME COLUMN stripe_customer_id TO paddle_customer_id");
    console.log("Renamed stripe_customer_id -> paddle_customer_id");
  } else {
    console.log("stripe_customer_id already renamed or absent — skipping");
  }

  if (await columnExists("stripe_subscription_id")) {
    await pool.query(
      "ALTER TABLE group_billing RENAME COLUMN stripe_subscription_id TO paddle_subscription_id",
    );
    console.log("Renamed stripe_subscription_id -> paddle_subscription_id");
  } else {
    console.log("stripe_subscription_id already renamed or absent — skipping");
  }

  const check = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'group_billing' AND column_name IN ('paddle_customer_id', 'paddle_subscription_id')
  `);
  console.log(
    check.rows.length === 2
      ? "Done — both Paddle columns exist."
      : "Something went wrong — expected both Paddle columns to exist after migration.",
  );

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
