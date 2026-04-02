const db = require('../database');
const jellyfin = require('../api/jellyfin');
const { syncRole } = require('../utils/roles');
const { auditLog } = require('../utils/audit');

/** Run every hour to handle expiry and 7-day warnings */
async function runExpiryCheck(client) {
  console.log('[expiry] Running expiry check...');

  // ── 1. Disable accounts that have expired ──────────────────────────────────
  const expired = db.getExpiredActiveUsers();
  for (const user of expired) {
    try {
      await jellyfin.setUserPolicy(user.jellyfin_id, true);
      db.setActive(user.discord_id, false);
      db.setWarnedFlag(user.discord_id, false); // reset warned so it triggers again if days added

      // Remove subscriber role
      await syncRole(client, user.discord_id, false);

      // Record in history and audit
      db.addSubHistory({
        discordId: user.discord_id,
        discordName: user.discord_name,
        event: 'expired',
        oldExpiry: user.expiry_date,
        reason: 'Subscription expired automatically',
        actor: 'system',
      });
      await auditLog(client, {
        action: 'subscription_expired',
        discordId: user.discord_id,
        discordName: user.discord_name,
        detail: `Expiry was ${user.expiry_date}`,
        actor: 'system',
      });

      // DM the user about their expired subscription
      try {
        const member = await client.users.fetch(user.discord_id);
        await member.send(
          `🔴 **Your Jellyfin subscription has expired.**\n\n` +
          `Your account (\`${user.username}\`) has been disabled. ` +
          `Contact the server owner to renew your subscription.`
        );
      } catch (dmErr) {
        console.warn(`[expiry] Could not DM expiry notice to ${user.discord_name}:`, dmErr.message);
        await auditLog(client, {
          action: 'expiry_dm_failed',
          discordId: user.discord_id,
          discordName: user.discord_name,
          detail: dmErr.message,
          actor: 'system',
        });
      }

      console.log(`[expiry] Disabled Jellyfin account for ${user.discord_name} (${user.discord_id})`);
    } catch (err) {
      console.error(`[expiry] Failed to disable ${user.discord_name}:`, err?.response?.data ?? err.message);
    }
  }

  // ── 2. Warn owner about accounts expiring within 7 days ────────────────────
  const expiringSoon = db.getUsersExpiringSoon();

  if (expiringSoon.length > 0) {
    const userWarnings = expiringSoon.map(u => {
      const diff = new Date(u.expiry_date) - new Date();
      const days = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
      return { user: u, days };
    });

    // Warn owner via DM
    try {
      const lines = userWarnings.map(w =>
        `• **${w.user.discord_name}** (\`${w.user.username}\`) — expires in **${w.days} day(s)**`
      );
      const owner = await client.users.fetch(process.env.OWNER_ID);
      await owner.send(
        `⏳ **Subscriptions expiring soon** (within 7 days):\n${lines.join('\n')}\n\n` +
        `Use \`/manage adddays\` to extend their subscription.`
      );
      console.log(`[expiry] Warned owner about ${expiringSoon.length} user(s) expiring soon.`);
    } catch (err) {
      console.error('[expiry] Failed to DM owner warning:', err.message);
    }

    // DM each user individually + mark as warned
    for (const { user, days } of userWarnings) {
      try {
        const member = await client.users.fetch(user.discord_id);
        await member.send(
          `⚠️ **Your Jellyfin subscription is expiring soon.**\n\n` +
          `Your account (\`${user.username}\`) expires in **${days} day(s)**. ` +
          `Contact the server owner to renew before it expires.`
        );
        await auditLog(client, {
          action: 'expiry_warning_sent',
          discordId: user.discord_id,
          discordName: user.discord_name,
          detail: `Expires in ${days} day(s) (${user.expiry_date})`,
          actor: 'system',
        });
      } catch (dmErr) {
        console.warn(`[expiry] Could not DM warning to ${user.discord_name}:`, dmErr.message);
        await auditLog(client, {
          action: 'expiry_dm_failed',
          discordId: user.discord_id,
          discordName: user.discord_name,
          detail: `Warning DM failed: ${dmErr.message}`,
          actor: 'system',
        });
      }

      db.setWarnedFlag(user.discord_id, true);
    }
  }

  // Log summary
  const summary = [];
  if (expired.length) summary.push(`${expired.length} account(s) disabled`);
  if (expiringSoon.length) summary.push(`${expiringSoon.length} warning(s) sent`);
  console.log(`[expiry] Done. ${summary.length ? summary.join(', ') + '.' : 'Nothing to do.'}`);
}

/** Start the hourly expiry scheduler */
function startExpiryScheduler(client) {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  // Run immediately on startup, then on interval
  runExpiryCheck(client).catch(err => console.error('[expiry] Startup check failed:', err));
  setInterval(() => runExpiryCheck(client).catch(err => console.error('[expiry] Check failed:', err)), INTERVAL_MS);

  console.log('[expiry] Scheduler started — checks every hour.');
}

module.exports = { startExpiryScheduler };
