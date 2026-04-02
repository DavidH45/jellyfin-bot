// Smoke test - checks all modules load without errors
require('./database');
require('./api/jellyfin');
require('./api/jellyseerr');
require('./commands/manage');
require('./commands/me');
require('./tasks/expiry');
console.log('All modules loaded OK');
// Clean up generated DB
const fs = require('fs');
if (fs.existsSync('./data.db')) fs.unlinkSync('./data.db');
