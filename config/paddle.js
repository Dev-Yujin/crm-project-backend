import { Paddle, Environment } from '@paddle/paddle-node-sdk';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const REQUIRED_ENV_VARS = ['PADDLE_API_KEY', 'PADDLE_ENVIRONMENT', 'PADDLE_WEBHOOK_SECRET'];

for (const name of REQUIRED_ENV_VARS) {
  if (!process.env[name]) {
    throw new Error(`Missing ${name} environment variable`);
  }
}

const ENVIRONMENTS = { sandbox: Environment.sandbox, production: Environment.production };
const environment = ENVIRONMENTS[process.env.PADDLE_ENVIRONMENT];

if (!environment) {
  throw new Error(
    `PADDLE_ENVIRONMENT must be "sandbox" or "production", got "${process.env.PADDLE_ENVIRONMENT}"`,
  );
}

export const paddle = new Paddle(process.env.PADDLE_API_KEY, { environment });
