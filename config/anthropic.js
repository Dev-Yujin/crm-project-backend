import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const REQUIRED_ENV_VARS = ['ANTHROPIC_API_KEY'];

for (const name of REQUIRED_ENV_VARS) {
  if (!process.env[name]) {
    throw new Error(`Missing ${name} environment variable`);
  }
}

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
