'use strict';
// Creates the first System Administrator for a LIVE (or demo) database.
// Usage: APP_MODE=live npm run create-admin -- <username> "<Full Name>"
// The password is read from the ADMIN_PASSWORD environment variable or prompted for.
const readline = require('readline');
const db = require('../server/lib/db');
const auth = require('../server/lib/auth');
const audit = require('../server/lib/audit');
db.open();
const [username, fullName] = process.argv.slice(2);
if (!username || !fullName) { console.error('Usage: APP_MODE=live npm run create-admin -- <username> "<Full Name>"'); process.exit(1); }
async function main() {
  let pw = process.env.ADMIN_PASSWORD;
  if (!pw) { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); pw = await new Promise(r => rl.question('Password (min 10 chars, letters+numbers): ', a => { rl.close(); r(a); })); }
  const p = auth.passwordProblem(pw); if (p) { console.error(p); process.exit(1); }
  const r = db.run(`INSERT INTO users(username, full_name, role, password_hash, must_change_password) VALUES (?,?,'admin',?,0)`, username, fullName, auth.hashPassword(pw));
  audit.log({ actor: 'cli' }, 'user.create', 'user', r.id, { username, role: 'admin', via: 'create-admin script' });
  console.log(`Administrator "${username}" created in ${db.MODE.toUpperCase()} database ${db.DB_FILE}`);
  db.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
