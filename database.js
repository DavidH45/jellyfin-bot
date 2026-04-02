const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'data.db'));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_id    TEXT PRIMARY KEY,
    discord_name  TEXT NOT NULL,
    jellyfin_id   TEXT,
    jellyseerr_id TEXT,
    username      TEXT,
    expiry_date   TEXT,
    is_active     INTEGER NOT NULL DEFAULT 0,
    warned        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
    action        TEXT NOT NULL,
    discord_id    TEXT,
    discord_name  TEXT,
    detail        TEXT,
    actor         TEXT
  );

  CREATE TABLE IF NOT EXISTS subscription_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
    discord_id    TEXT NOT NULL,
    discord_name  TEXT NOT NULL,
    event         TEXT NOT NULL,
    days          INTEGER,
    old_expiry    TEXT,
    new_expiry    TEXT,
    reason        TEXT,
    actor         TEXT
  );
`);

// ─── User CRUD ────────────────────────────────────────────────────────────────

function getUser(discordId) {
  return db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
}

function getUserByJellyfinId(jellyfinId) {
  return db.prepare('SELECT * FROM users WHERE jellyfin_id = ?').get(jellyfinId);
}

function createUser({ discordId, discordName, jellyfinId, jellyseerrId, username }) {
  return db.prepare(`
    INSERT INTO users (discord_id, discord_name, jellyfin_id, jellyseerr_id, username)
    VALUES (@discordId, @discordName, @jellyfinId, @jellyseerrId, @username)
  `).run({ discordId, discordName, jellyfinId, jellyseerrId, username });
}

function deleteUser(discordId) {
  return db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);
}

// ─── Subscription management ─────────────────────────────────────────────────

/**
 * Add or extend days on a user's subscription.
 * If the account has no expiry yet (or is expired), the new expiry is set from now.
 * If the account is currently active (expiry in the future), days are appended on top.
 */
function addDays(discordId, daysToAdd) {
  const user = getUser(discordId);
  if (!user) throw new Error('User not found in database.');

  const now = new Date();

  let baseDate;
  if (user.expiry_date) {
    const existing = new Date(user.expiry_date);
    // If expiry is still in the future, add on top of it; otherwise start from now
    baseDate = existing > now ? existing : now;
  } else {
    baseDate = now;
  }

  baseDate.setDate(baseDate.getDate() + daysToAdd);
  const newExpiry = baseDate.toISOString();

  db.prepare(`
    UPDATE users
    SET expiry_date = ?, is_active = 1, warned = 0
    WHERE discord_id = ?
  `).run(newExpiry, discordId);

  return newExpiry;
}

/**
 * Remove days from a user's subscription.
 * If the resulting date is in the past, is_active is set to 0 and the caller
 * should also disable the Jellyfin account.
 * Returns { newExpiry, nowExpired }
 */
function removeDays(discordId, daysToRemove) {
  const user = getUser(discordId);
  if (!user) throw new Error('User not found in database.');

  if (!user.expiry_date) throw new Error('User has no active subscription to remove days from.');

  const expiry = new Date(user.expiry_date);
  expiry.setDate(expiry.getDate() - daysToRemove);
  const newExpiry = expiry.toISOString();
  const nowExpired = expiry <= new Date();

  db.prepare(`
    UPDATE users
    SET expiry_date = ?, is_active = ?, warned = 0
    WHERE discord_id = ?
  `).run(newExpiry, nowExpired ? 0 : user.is_active, discordId);

  return { newExpiry, nowExpired };
}

function setActive(discordId, active) {
  return db.prepare('UPDATE users SET is_active = ? WHERE discord_id = ?')
    .run(active ? 1 : 0, discordId);
}

function setWarnedFlag(discordId, warned) {
  return db.prepare('UPDATE users SET warned = ? WHERE discord_id = ?')
    .run(warned ? 1 : 0, discordId);
}

// ─── Expiry task queries ──────────────────────────────────────────────────────

/** All users with an active subscription (is_active = 1 and expiry in the future) */
function getActiveSubscribers() {
  return db.prepare(`
    SELECT * FROM users
    WHERE is_active = 1
      AND expiry_date IS NOT NULL
      AND datetime(expiry_date) > datetime('now')
  `).all();
}

/** All active users whose subscription has passed right now */
function getExpiredActiveUsers() {
  return db.prepare(`
    SELECT * FROM users
    WHERE is_active = 1
      AND expiry_date IS NOT NULL
      AND datetime(expiry_date) <= datetime('now')
  `).all();
}

/** Active users expiring within the next 7 days who haven't been warned yet */
function getUsersExpiringSoon() {
  return db.prepare(`
    SELECT * FROM users
    WHERE is_active = 1
      AND warned = 0
      AND expiry_date IS NOT NULL
      AND datetime(expiry_date) > datetime('now')
      AND datetime(expiry_date) <= datetime('now', '+7 days')
  `).all();
}

// ─── List / stats queries ─────────────────────────────────────────────────────

/**
 * Return all users ordered by expiry date ascending (nulls last).
 * filter: 'all' | 'active' | 'expired' | 'expiring-soon'
 */
function getAllUsers(filter = 'all') {
  const base = `SELECT * FROM users`;
  const order = `ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END ASC, expiry_date ASC`;

  switch (filter) {
    case 'active':
      return db.prepare(`${base} WHERE is_active = 1 ${order}`).all();
    case 'expired':
      return db.prepare(`${base} WHERE is_active = 0 AND expiry_date IS NOT NULL ${order}`).all();
    case 'expiring-soon':
      return db.prepare(`
        ${base}
        WHERE is_active = 1
          AND expiry_date IS NOT NULL
          AND datetime(expiry_date) > datetime('now')
          AND datetime(expiry_date) <= datetime('now', '+7 days')
        ${order}
      `).all();
    default:
      return db.prepare(`${base} ${order}`).all();
  }
}

/** Returns aggregate stats about all users */
function getStats() {
  return db.prepare(`
    SELECT
      COUNT(*)                                                 AS total,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END)          AS active,
      SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END)          AS disabled,
      SUM(CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END)     AS noExpiry,
      SUM(CASE
        WHEN is_active = 1
          AND expiry_date IS NOT NULL
          AND datetime(expiry_date) > datetime('now')
          AND datetime(expiry_date) <= datetime('now', '+7 days')
        THEN 1 ELSE 0 END)                                     AS expiringSoon
    FROM users
  `).get();
}

// ─── Audit log ─────────────────────────────────────────────────────────────────

/**
 * Insert a row into the audit log.
 * @param {object} entry
 * @param {string} entry.action   - Short action label, e.g. 'account_created'
 * @param {string} [entry.discordId]
 * @param {string} [entry.discordName]
 * @param {string} [entry.detail] - Human-readable extra info
 * @param {string} [entry.actor]  - Who triggered it ('system' | discord username)
 */
function addAuditLog({ action, discordId = null, discordName = null, detail = null, actor = 'system' }) {
  db.prepare(`
    INSERT INTO audit_log (action, discord_id, discord_name, detail, actor)
    VALUES (?, ?, ?, ?, ?)
  `).run(action, discordId, discordName, detail, actor);
}

/**
 * Retrieve recent audit log entries.
 * @param {number} limit  - Max rows to return (default 50)
 * @param {string} [discordId] - If set, filter to a specific user
 */
function getAuditLog(limit = 50, discordId = null) {
  if (discordId) {
    return db.prepare(`
      SELECT * FROM audit_log WHERE discord_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(discordId, limit);
  }
  return db.prepare(`
    SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?
  `).all(limit);
}

// ─── Subscription history ─────────────────────────────────────────────────────

/**
 * Insert a subscription history event.
 * @param {object} entry
 * @param {string} entry.discordId
 * @param {string} entry.discordName
 * @param {string} entry.event      - e.g. 'days_added' | 'days_removed' | 'expired' | 'activated' | 'disabled' | 'days_added_all'
 * @param {number} [entry.days]
 * @param {string} [entry.oldExpiry]
 * @param {string} [entry.newExpiry]
 * @param {string} [entry.reason]
 * @param {string} [entry.actor]
 */
function addSubHistory({ discordId, discordName, event, days = null, oldExpiry = null, newExpiry = null, reason = null, actor = 'system' }) {
  db.prepare(`
    INSERT INTO subscription_history (discord_id, discord_name, event, days, old_expiry, new_expiry, reason, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(discordId, discordName, event, days, oldExpiry, newExpiry, reason, actor);
}

/**
 * Get subscription history for a specific user, newest first.
 * @param {string} discordId
 * @param {number} limit
 */
function getSubHistory(discordId, limit = 25) {
  return db.prepare(`
    SELECT * FROM subscription_history WHERE discord_id = ?
    ORDER BY timestamp DESC LIMIT ?
  `).all(discordId, limit);
}

// ─── Backup / restore ─────────────────────────────────────────────────────────

/** Return every row from all three tables, suitable for re-importing later. */
function exportData() {
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    users: db.prepare('SELECT * FROM users').all(),
    audit_log: db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all(),
    subscription_history: db.prepare('SELECT * FROM subscription_history ORDER BY id ASC').all(),
  };
}

/**
 * Wipe all three tables and rebuild them from the provided backup payload.
 * Runs inside a single transaction — either all rows land or none do.
 * @param {{ users: object[], audit_log: object[], subscription_history: object[] }} payload
 */
function importData({ users, audit_log, subscription_history }) {
  const doImport = db.transaction(() => {
    db.prepare('DELETE FROM subscription_history').run();
    db.prepare('DELETE FROM audit_log').run();
    db.prepare('DELETE FROM users').run();

    const insertUser = db.prepare(`
      INSERT INTO users
        (discord_id, discord_name, jellyfin_id, jellyseerr_id, username, expiry_date, is_active, warned, created_at)
      VALUES
        (@discord_id, @discord_name, @jellyfin_id, @jellyseerr_id, @username, @expiry_date, @is_active, @warned, @created_at)
    `);
    for (const u of users) insertUser.run(u);

    const insertAudit = db.prepare(`
      INSERT INTO audit_log (id, timestamp, action, discord_id, discord_name, detail, actor)
      VALUES (@id, @timestamp, @action, @discord_id, @discord_name, @detail, @actor)
    `);
    for (const a of audit_log) insertAudit.run(a);

    const insertHistory = db.prepare(`
      INSERT INTO subscription_history
        (id, timestamp, discord_id, discord_name, event, days, old_expiry, new_expiry, reason, actor)
      VALUES
        (@id, @timestamp, @discord_id, @discord_name, @event, @days, @old_expiry, @new_expiry, @reason, @actor)
    `);
    for (const h of subscription_history) insertHistory.run(h);
  });

  doImport();
}

module.exports = {
  getUser,
  getUserByJellyfinId,
  createUser,
  deleteUser,
  addDays,
  removeDays,
  setActive,
  setWarnedFlag,
  getExpiredActiveUsers,
  getUsersExpiringSoon,
  getActiveSubscribers,
  getAllUsers,
  getStats,
  // audit log
  addAuditLog,
  getAuditLog,
  // subscription history
  addSubHistory,
  getSubHistory,
  // backup / restore
  exportData,
  importData,
};
