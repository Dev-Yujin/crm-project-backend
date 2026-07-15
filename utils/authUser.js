import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SALT_ROUNDS = process.env.SALT_ROUNDS;

export async function hashPassword(password) {
  const saltRounds = parseInt(SALT_ROUNDS, 10);
  const hashedPassword = await bcrypt.hash(password, saltRounds);
  return hashedPassword;
}

export async function comparePasswords(plainPassword, hashedPassword) {
  const isMatch = await bcrypt.compare(plainPassword, hashedPassword);
  return isMatch;
}