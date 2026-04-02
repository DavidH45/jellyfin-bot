const { EmbedBuilder } = require('discord.js');
const db = require('../database');

// Action → human label + colour mapping
const ACTION_META = {
  account_created:       { label: 'Account Created',          color: 0x57F287 },
  account_linked:        { label: 'Account Linked',           color: 0x57F287 },
  account_removed:       { label: 'Account Removed',          color: 0xED4245 },
  account_reset:         { label: 'Account Reset',            color: 0xED4245 },
  account_enabled:       { label: 'Account Enabled',          color: 0x57F287 },
  account_disabled:      { label: 'Account Disabled',         color: 0xED4245 },
  days_added:            { label: 'Days Added',               color: 0x5865F2 },
  days_removed:          { label: 'Days Removed',             color: 0xFEE75C },
  days_added_all:        { label: 'Days Added (All Users)',    color: 0x5865F2 },
  password_reset:        { label: 'Password Reset',           color: 0xFEE75C },
  subscription_expired:  { label: 'Subscription Expired',     color: 0xED4245 },
  expiry_warning_sent:   { label: 'Expiry Warning DM Sent',   color: 0xFEE75C },
  expiry_dm_failed:      { label: 'Expiry DM Failed',         color: 0x99AAB5 },
  welcome_dm_sent:       { label: 'Welcome DM Sent',          color: 0x57F287 },
  welcome_dm_failed:     { label: 'Welcome DM Failed',        color: 0x99AAB5 },
  sync_check_run:        { label: 'Sync Check Run',           color: 0x5865F2 },
};

/**
 * Log an action to the DB audit table and post an embed to the audit log channel.
 *
 * @param {import('discord.js').Client} client
 * @param {object} entry
 * @param {string}  entry.action       - Key from ACTION_META
 * @param {string}  [entry.discordId]
 * @param {string}  [entry.discordName]
 * @param {string}  [entry.detail]     - Extra context line shown in embed
 * @param {string}  [entry.actor]      - Who triggered it (display name or 'system')
 */
async function auditLog(client, { action, discordId = null, discordName = null, detail = null, actor = 'system' }) {
  // Always write to DB
  db.addAuditLog({ action, discordId, discordName, detail, actor });

  const channelId = process.env.AUDIT_LOG_CHANNEL_ID;
  if (!channelId) return; // audit channel not configured — DB-only

  try {
    const channel = client.channels.cache.get(channelId) ?? await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    const meta = ACTION_META[action] ?? { label: action, color: 0x99AAB5 };

    const embed = new EmbedBuilder()
      .setColor(meta.color)
      .setTitle(meta.label)
      .setTimestamp();

    if (discordId) embed.addFields({ name: 'User', value: `<@${discordId}> (${discordName ?? discordId})`, inline: true });
    embed.addFields({ name: 'Actor', value: actor, inline: true });
    if (detail) embed.addFields({ name: 'Detail', value: detail, inline: false });

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.warn('[audit] Failed to post audit log embed:', err.message);
  }
}

module.exports = { auditLog };
