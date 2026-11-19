/**
 * Liest ein Passwort von stdin (eine Zeile) und gibt NUR seinen scrypt-Hash aus.
 * Wird von scripts/set-admin-password.sh benutzt – das Passwort erscheint nie in
 * Argumenten, Umgebungsvariablen, Dateien oder Logs.
 */
import { randomBytes } from 'node:crypto';
import { hashPassword, passwordProblem, verifyPassword } from '../supabase/functions/_shared/adminLogin.ts';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
const problem = passwordProblem(password);
if (problem) {
  console.error(`Passwort zu schwach: ${problem}`);
  process.exit(2);
}
const hash = hashPassword(password, randomBytes(16));
if (!verifyPassword(password, hash)) {
  console.error('Hash-Prüfung fehlgeschlagen');
  process.exit(3);
}
process.stdout.write(hash);
