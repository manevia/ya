'use strict';
// Take an immediate database backup (used by deploy/update.sh before every update). Usage: node scripts/backup-now.js [label]
const db = require('../server/lib/db');
db.open();
const f = db.backup(process.argv[2] || 'manual');
console.log(f);
db.close();
