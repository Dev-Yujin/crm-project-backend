import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SALT_ROUNDS = process.env.SALT_ROUNDS;
const MEMBER_JWT_SECRET = process.env.MEMBER_JWT_SECRET;

export async function hashPassword(password) {
  const saltRounds = parseInt(SALT_ROUNDS, 10);
  const hashedPassword = await bcrypt.hash(password, saltRounds);
  return hashedPassword;
}

export async function comparePasswords(plainPassword, hashedPassword) {
  const isMatch = await bcrypt.compare(plainPassword, hashedPassword);
  return isMatch;
}

export function generateMemberToken(member) {
  return jwt.sign(
    { uuid: member.uuid, username: member.username, email: member.email, tokenVersion: member.token_version ?? 0 },
    MEMBER_JWT_SECRET,
    { expiresIn: '1d' }
  );
}

export function verifyMemberToken(token) {
  return jwt.verify(token, MEMBER_JWT_SECRET);
}