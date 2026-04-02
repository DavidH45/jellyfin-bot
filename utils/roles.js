/**
 * Sync the subscriber Discord role for a user.
 * No-ops silently if GUILD_ID or SUBSCRIBER_ROLE_ID are not set.
 */
async function syncRole(client, discordId, active) {
  const { GUILD_ID, SUBSCRIBER_ROLE_ID } = process.env;
  if (!GUILD_ID || !SUBSCRIBER_ROLE_ID) return;

  try {
    const guild = client.guilds.cache.get(GUILD_ID) ?? await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);

    if (active) {
      await member.roles.add(SUBSCRIBER_ROLE_ID);
    } else {
      await member.roles.remove(SUBSCRIBER_ROLE_ID);
    }
  } catch (err) {
    // Non-fatal: user may not be in the guild, role may not exist, etc.
    console.warn(`[roles] syncRole failed for ${discordId} (active=${active}):`, err.message);
  }
}

module.exports = { syncRole };
