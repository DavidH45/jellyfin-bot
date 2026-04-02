const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const db = require('../database');
const jellyfin = require('../api/jellyfin');
const jellyseerr = require('../api/jellyseerr');
const { syncRole } = require('../utils/roles');
const { auditLog } = require('../utils/audit');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a random alphanumeric password of given length */
function generatePassword(length = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** Sanitize a Discord display name into a valid Jellyfin username */
function sanitizeUsername(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-zA-Z0-9_\-\.]/g, '_') // replace invalid chars with underscore
    .replace(/_+/g, '_') // collapse consecutive underscores
    .replace(/^_|_$/g, '') // strip leading/trailing underscores
    .slice(0, 32) // Jellyfin username length limit
    || 'user'; // fallback if name becomes empty
}

/** Format an ISO date string to a readable format */
function formatDate(iso) {
  if (!iso) return 'None';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Calculate days remaining from an ISO expiry string */
function daysRemaining(iso) {
  if (!iso) return 0;
  const diff = new Date(iso) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

/** Assert the caller is the bot owner, send ephemeral error if not */
function isOwner(interaction) {
  return interaction.user.id === process.env.OWNER_ID;
}

// ─── Subcommand handlers ──────────────────────────────────────────────────────

async function handleSetup(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const target = interaction.options.getUser('user');

  // Prevent duplication
  const existing = db.getUser(target.id);
  if (existing) {
    return interaction.editReply(`❌ **${target.username}** already has an account (\`${existing.username}\`).`);
  }

  const username = sanitizeUsername(target.displayName || target.username);
  const password = generatePassword();

  let jellyfinUser;
  try {
    jellyfinUser = await jellyfin.createUser(username, password);
  } catch (err) {
    console.error('[setup] Jellyfin createUser error:', err?.response?.data ?? err.message);
    return interaction.editReply(`❌ Failed to create Jellyfin account: \`${err?.response?.data?.Message ?? err.message}\``);
  }

  // Disable the account immediately — they need days added first
  try {
    await jellyfin.setUserPolicy(jellyfinUser.Id, true);
  } catch (err) {
    console.error('[setup] Jellyfin setUserPolicy error:', err?.response?.data ?? err.message);
    return interaction.editReply('❌ Jellyfin account created but could not be disabled. Check logs.');
  }

  // Import into Jellyseerr
  let jellyseerrId = null;
  try {
    const imported = await jellyseerr.importFromJellyfin([jellyfinUser.Id]);
    const match = imported.find(u => u.jellyfinUserId === jellyfinUser.Id);
    jellyseerrId = match?.id?.toString() ?? null;
  } catch (err) {
    // Non-fatal: log but continue. Jellyseerr may not be configured.
    console.warn('[setup] Jellyseerr import failed (non-fatal):', err?.response?.data ?? err.message);
  }

  // Persist to local DB
  db.createUser({
    discordId: target.id,
    discordName: target.tag || target.username,
    jellyfinId: jellyfinUser.Id,
    jellyseerrId,
    username,
  });

  // DM the owner with credentials (password never hits the DB)
  const owner = await interaction.client.users.fetch(process.env.OWNER_ID);
  await owner.send(
    `🆕 **New account created** for <@${target.id}> (${target.tag || target.username})\n` +
    `> **Jellyfin Username:** \`${username}\`\n` +
    `> **Jellyfin Password:** \`${password}\`\n` +
    `> **Status:** Disabled (no days added yet)\n` +
    (jellyseerrId ? `> **Jellyseerr User ID:** \`${jellyseerrId}\`` : `> **Jellyseerr:** Import failed or unavailable`)
  );

  await auditLog(interaction.client, {
    action: 'account_created',
    discordId: target.id,
    discordName: target.tag || target.username,
    detail: `Jellyfin username: \`${username}\`${jellyseerrId ? ` | Jellyseerr ID: ${jellyseerrId}` : ''}`,
    actor: interaction.user.username,
  });

  db.addSubHistory({
    discordId: target.id,
    discordName: target.tag || target.username,
    event: 'account_created',
    reason: 'Account created via /manage setup',
    actor: interaction.user.username,
  });

  await interaction.editReply(
    `✅ Account created for **${target.username}**.\n` +
    `• Jellyfin username: \`${username}\`\n` +
    `• **Credentials sent to you via DM.**\n` +
    `• Account is **disabled** until you run \`/manage adddays\`.`
  );
}

async function handleAddDays(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const target = interaction.options.getUser('user');
  const days = interaction.options.getInteger('days');
  const reason = interaction.options.getString('reason');

  if (days <= 0) {
    return interaction.editReply('❌ Days must be a positive integer.');
  }

  const user = db.getUser(target.id);
  if (!user) {
    return interaction.editReply(`❌ No account found for **${target.username}**. Run \`/manage setup\` first.`);
  }

  // Detect first-ever activation (no expiry means never been activated before)
  const isFirstActivation = !user.expiry_date;
  const oldExpiry = user.expiry_date ?? null;

  const newExpiry = db.addDays(target.id, days);

  // Enable Jellyfin account
  try {
    await jellyfin.setUserPolicy(user.jellyfin_id, false);
  } catch (err) {
    console.error('[adddays] Jellyfin setUserPolicy error:', err?.response?.data ?? err.message);
    return interaction.editReply('❌ Days added in DB but failed to enable Jellyfin account. Check logs.');
  }

  // Assign subscriber role
  await syncRole(interaction.client, target.id, true);

  // Welcome DM on first activation
  if (isFirstActivation) {
    try {
      await target.send(
        `👋 **Welcome to Jellyfin!** Your account has been activated.\n\n` +
        `> **Jellyfin Username:** \`${user.username}\`\n` +
        `> **Server URL:** ${process.env.JELLYFIN_URL}\n` +
        `> **Subscription expires:** ${formatDate(newExpiry)}\n\n` +
        `Use \`/setup\` to get download links for all Jellyfin apps.\n` +
        `Contact the server owner if you need help getting started.`
      );
      await auditLog(interaction.client, {
        action: 'welcome_dm_sent',
        discordId: target.id,
        discordName: target.tag || target.username,
        actor: interaction.user.username,
      });
    } catch (err) {
      console.warn(`[adddays] Could not DM welcome to ${target.username}:`, err.message);
      await auditLog(interaction.client, {
        action: 'welcome_dm_failed',
        discordId: target.id,
        discordName: target.tag || target.username,
        detail: err.message,
        actor: interaction.user.username,
      });
    }
  } else {
    // Renewal DM for existing subscribers
    try {
      await target.send(
        `✅ **Your Jellyfin subscription has been extended!**\n\n` +
        `> **+${days} day(s)** added\n` +
        `> **New expiry:** ${formatDate(newExpiry)}\n` +
        (reason ? `> **Note:** ${reason}\n` : '') +
        `\nEnjoy streaming!`
      );
    } catch (err) {
      console.warn(`[adddays] Could not DM renewal notice to ${target.username}:`, err.message);
    }
  }

  await auditLog(interaction.client, {
    action: 'days_added',
    discordId: target.id,
    discordName: target.tag || target.username,
    detail: `+${days} day(s) | New expiry: ${formatDate(newExpiry)}${reason ? ` | Reason: ${reason}` : ''}`,
    actor: interaction.user.username,
  });

  db.addSubHistory({
    discordId: target.id,
    discordName: target.tag || target.username,
    event: isFirstActivation ? 'activated' : 'days_added',
    days,
    oldExpiry,
    newExpiry,
    reason,
    actor: interaction.user.username,
  });

  await interaction.editReply(
    `✅ Added **${days} day(s)** to **${target.username}**.\n` +
    `• New expiry: **${formatDate(newExpiry)}**\n` +
    `• Jellyfin account: **enabled**\n` +
    (isFirstActivation ? '• 👋 Welcome DM sent to user.' : '• 📬 Renewal DM sent to user.')
  );
}

async function handleRemoveDays(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const target = interaction.options.getUser('user');
  const days = interaction.options.getInteger('days');
  const reason = interaction.options.getString('reason');

  if (days <= 0) {
    return interaction.editReply('❌ Days must be a positive integer.');
  }

  const user = db.getUser(target.id);
  if (!user) {
    return interaction.editReply(`❌ No account found for **${target.username}**.`);
  }

  const oldExpiry = user.expiry_date;

  let result;
  try {
    result = db.removeDays(target.id, days);
  } catch (err) {
    return interaction.editReply(`❌ ${err.message}`);
  }

  let statusNote = '';
  if (result.nowExpired) {
    try {
      await jellyfin.setUserPolicy(user.jellyfin_id, true);
      await syncRole(interaction.client, target.id, false);
      statusNote = '\n• Jellyfin account: **disabled** (subscription expired)';
    } catch (err) {
      console.error('[removedays] Jellyfin setUserPolicy error:', err?.response?.data ?? err.message);
      statusNote = '\n• ⚠️ Failed to disable Jellyfin account. Check logs.';
    }
  }

  await auditLog(interaction.client, {
    action: 'days_removed',
    discordId: target.id,
    discordName: target.tag || target.username,
    detail: `-${days} day(s) | New expiry: ${formatDate(result.newExpiry)}${result.nowExpired ? ' | Account disabled' : ''}${reason ? ` | Reason: ${reason}` : ''}`,
    actor: interaction.user.username,
  });

  db.addSubHistory({
    discordId: target.id,
    discordName: target.tag || target.username,
    event: result.nowExpired ? 'expired' : 'days_removed',
    days: -days,
    oldExpiry,
    newExpiry: result.newExpiry,
    reason,
    actor: interaction.user.username,
  });

  await interaction.editReply(
    `✅ Removed **${days} day(s)** from **${target.username}**.\n` +
    `• New expiry: **${formatDate(result.newExpiry)}**` +
    statusNote
  );
}

async function handleInfo(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const target = interaction.options.getUser('user');
  const user = db.getUser(target.id);

  if (!user) {
    return interaction.editReply(`❌ No account found for **${target.username}**.`);
  }

  const remaining = daysRemaining(user.expiry_date);
  const statusEmoji = user.is_active ? '🟢' : '🔴';

  const embed = new EmbedBuilder()
    .setTitle(`Account Info — ${target.username}`)
    .setThumbnail(target.displayAvatarURL())
    .setColor(user.is_active ? 0x57F287 : 0xED4245)
    .addFields(
      { name: 'Discord', value: `<@${user.discord_id}> (${user.discord_name})`, inline: false },
      { name: 'Jellyfin Username', value: `\`${user.username}\``, inline: true },
      { name: 'Status', value: `${statusEmoji} ${user.is_active ? 'Active' : 'Disabled'}`, inline: true },
      { name: 'Expiry Date', value: formatDate(user.expiry_date), inline: true },
      { name: 'Days Remaining', value: user.expiry_date ? `${remaining}` : 'N/A', inline: true },
      { name: 'Jellyfin ID', value: user.jellyfin_id ?? 'N/A', inline: true },
      { name: 'Jellyseerr ID', value: user.jellyseerr_id ?? 'N/A', inline: true },
      { name: 'Account Created', value: formatDate(user.created_at), inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleDisable(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const target = interaction.options.getUser('user');
  const user = db.getUser(target.id);
  if (!user) {
    return interaction.editReply(`❌ No account found for **${target.username}**.`);
  }

  try {
    await jellyfin.setUserPolicy(user.jellyfin_id, true);
    db.setActive(target.id, false);
    await syncRole(interaction.client, target.id, false);
    await auditLog(interaction.client, {
      action: 'account_disabled',
      discordId: target.id,
      discordName: target.tag || target.username,
      detail: 'Manually disabled via /manage disable',
      actor: interaction.user.username,
    });
    db.addSubHistory({
      discordId: target.id,
      discordName: target.tag || target.username,
      event: 'disabled',
      reason: 'Manually disabled via /manage disable',
      actor: interaction.user.username,
    });
    await interaction.editReply(`✅ Jellyfin account for **${target.username}** has been **disabled**.`);
  } catch (err) {
    console.error('[disable] error:', err?.response?.data ?? err.message);
    await interaction.editReply('❌ Failed to disable Jellyfin account. Check logs.');
  }
}

async function handleEnable(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const target = interaction.options.getUser('user');
  const user = db.getUser(target.id);
  if (!user) {
    return interaction.editReply(`❌ No account found for **${target.username}**.`);
  }

  try {
    await jellyfin.setUserPolicy(user.jellyfin_id, false);
    db.setActive(target.id, true);
    await syncRole(interaction.client, target.id, true);
    await auditLog(interaction.client, {
      action: 'account_enabled',
      discordId: target.id,
      discordName: target.tag || target.username,
      detail: 'Manually enabled via /manage enable',
      actor: interaction.user.username,
    });
    db.addSubHistory({
      discordId: target.id,
      discordName: target.tag || target.username,
      event: 'enabled',
      reason: 'Manually enabled via /manage enable',
      actor: interaction.user.username,
    });
    await interaction.editReply(`✅ Jellyfin account for **${target.username}** has been **enabled**.`);
  } catch (err) {
    console.error('[enable] error:', err?.response?.data ?? err.message);
    await interaction.editReply('❌ Failed to enable Jellyfin account. Check logs.');
  }
}

async function handleResetPassword(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const target = interaction.options.getUser('user');
  const user = db.getUser(target.id);
  if (!user) {
    return interaction.editReply(`❌ No account found for **${target.username}**.`);
  }

  const newPassword = generatePassword();

  try {
    await jellyfin.setPassword(user.jellyfin_id, newPassword);
  } catch (err) {
    console.error('[resetpassword] Jellyfin setPassword error:', err?.response?.data ?? err.message);
    return interaction.editReply('❌ Failed to reset password in Jellyfin. Check logs.');
  }

  const owner = await interaction.client.users.fetch(process.env.OWNER_ID);
  await owner.send(
    `🔑 **Password reset** for <@${target.id}> (${target.tag || target.username})\n` +
    `> **Jellyfin Username:** \`${user.username}\`\n` +
    `> **New Password:** \`${newPassword}\``
  );

  await auditLog(interaction.client, {
    action: 'password_reset',
    discordId: target.id,
    discordName: target.tag || target.username,
    detail: 'Password reset via /manage resetpassword',
    actor: interaction.user.username,
  });

  await interaction.editReply(`✅ Password reset for **${target.username}**. New credentials sent to you via DM.`);
}

async function handleRemove(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const target = interaction.options.getUser('user');
  const user = db.getUser(target.id);
  if (!user) {
    return interaction.editReply(`❌ No account found for **${target.username}**.`);
  }

  const errors = [];

  // Remove subscriber role first (non-fatal)
  await syncRole(interaction.client, target.id, false);

  // Delete from Jellyfin
  try {
    await jellyfin.deleteUser(user.jellyfin_id);
  } catch (err) {
    console.error('[remove] Jellyfin deleteUser error:', err?.response?.data ?? err.message);
    errors.push('Jellyfin deletion failed (account may already be gone).');
  }

  // Remove from local DB
  db.deleteUser(target.id);

  await auditLog(interaction.client, {
    action: 'account_removed',
    discordId: target.id,
    discordName: target.tag || target.username,
    detail: `Jellyfin username: \`${user.username}\``,
    actor: interaction.user.username,
  });

  const errorNote = errors.length > 0 ? `\n⚠️ ${errors.join('\n⚠️ ')}` : '';
  await interaction.editReply(
    `✅ Account for **${target.username}** (\`${user.username}\`) has been removed.${errorNote}`
  );
}

async function handleReset(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const target = interaction.options.getUser('user');
  const user = db.getUser(target.id);
  if (!user) {
    return interaction.editReply(`❌ No account found for **${target.username}**.`);
  }

  const errors = [];

  // Remove subscriber role (non-fatal)
  await syncRole(interaction.client, target.id, false);

  // Delete from Jellyfin
  try {
    await jellyfin.deleteUser(user.jellyfin_id);
  } catch (err) {
    console.error('[reset] Jellyfin deleteUser error:', err?.response?.data ?? err.message);
    errors.push('Jellyfin deletion failed (account may already be gone).');
  }

  // Wipe from local DB
  db.deleteUser(target.id);

  await auditLog(interaction.client, {
    action: 'account_reset',
    discordId: target.id,
    discordName: target.tag || target.username,
    detail: `Full reset — Jellyfin username: \`${user.username}\``,
    actor: interaction.user.username,
  });

  const errorNote = errors.length > 0 ? `\n⚠️ ${errors.join('\n⚠️ ')}` : '';
  await interaction.editReply(
    `🗑️ **Full reset** complete for **${target.username}** (\`${user.username}\`). Jellyfin account deleted, DB record wiped, role removed.${errorNote}`
  );
}

async function handleList(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const filter = interaction.options.getString('filter') ?? 'all';
  const users = db.getAllUsers(filter);

  if (users.length === 0) {
    return interaction.editReply(`No users found${filter !== 'all' ? ` matching filter \`${filter}\`` : ''}.`);
  }

  const lines = users.map(u => {
    const emoji = u.is_active ? '🟢' : '🔴';
    const expiry = u.expiry_date
      ? `${formatDate(u.expiry_date)} (${daysRemaining(u.expiry_date)}d)`
      : 'no expiry';
    return `${emoji} <@${u.discord_id}> \`${u.username}\` — ${expiry}`;
  });

  // Discord embed description cap is 4096 chars — truncate gracefully
  let description = lines.join('\n');
  if (description.length > 4000) {
    description = description.slice(0, 4000) + `\n…(truncated, ${users.length} total)`;
  }

  const filterLabel = filter.charAt(0).toUpperCase() + filter.slice(1);
  const embed = new EmbedBuilder()
    .setTitle(`Jellyfin Users — ${filterLabel}`)
    .setDescription(description)
    .setFooter({ text: `${users.length} user(s) shown` })
    .setColor(0x5865F2)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleStats(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const s = db.getStats();

  const embed = new EmbedBuilder()
    .setTitle('Jellyfin Subscriber Stats')
    .setColor(0x5865F2)
    .addFields(
      { name: 'Total Users', value: `${s.total}`, inline: true },
      { name: 'Active', value: `🟢 ${s.active}`, inline: true },
      { name: 'Disabled', value: `🔴 ${s.disabled}`, inline: true },
      { name: 'Expiring in 7 Days', value: `⚠️ ${s.expiringSoon}`, inline: true },
      { name: 'No Expiry Set', value: `${s.noExpiry}`, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleLink(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const target = interaction.options.getUser('user');
  const jellyfinUsername = interaction.options.getString('jellyfin-username');

  // Prevent duplicate Discord-side entry
  const existing = db.getUser(target.id);
  if (existing) {
    return interaction.editReply(`❌ **${target.username}** already has a linked account (\`${existing.username}\`).`);
  }

  // Find the Jellyfin user by username
  let jellyfinUser;
  try {
    const allUsers = await jellyfin.listUsers();
    jellyfinUser = allUsers.find(u => u.Name.toLowerCase() === jellyfinUsername.toLowerCase());
  } catch (err) {
    console.error('[link] Jellyfin listUsers error:', err?.response?.data ?? err.message);
    return interaction.editReply(`❌ Failed to fetch Jellyfin users: \`${err?.response?.data?.Message ?? err.message}\``);
  }

  if (!jellyfinUser) {
    return interaction.editReply(`❌ No Jellyfin user found with username \`${jellyfinUsername}\`. Check the exact username in Jellyfin.`);
  }

  // Prevent the same Jellyfin account being linked twice
  const alreadyLinked = db.getUserByJellyfinId(jellyfinUser.Id);
  if (alreadyLinked) {
    return interaction.editReply(`❌ That Jellyfin account is already linked to <@${alreadyLinked.discord_id}>.`);
  }

  // Disable the account — no days added yet (may fail for admin accounts)
  let isAdminAccount = false;
  try {
    await jellyfin.setUserPolicy(jellyfinUser.Id, true);
  } catch (err) {
    console.warn('[link] Could not disable Jellyfin account — assuming admin account, continuing:', err?.response?.data ?? err.message);
    isAdminAccount = true;
  }

  // Import into Jellyseerr (non-fatal)
  let jellyseerrId = null;
  try {
    const imported = await jellyseerr.importFromJellyfin([jellyfinUser.Id]);
    const match = imported.find(u => u.jellyfinUserId === jellyfinUser.Id);
    jellyseerrId = match?.id?.toString() ?? null;
  } catch (err) {
    console.warn('[link] Jellyseerr import failed (non-fatal):', err?.response?.data ?? err.message);
  }

  // Persist to local DB
  db.createUser({
    discordId: target.id,
    discordName: target.tag || target.username,
    jellyfinId: jellyfinUser.Id,
    jellyseerrId,
    username: jellyfinUser.Name,
  });

  // DM the owner with link details
  const owner = await interaction.client.users.fetch(process.env.OWNER_ID);
  await owner.send(
    `🔗 **Account linked** for <@${target.id}> (${target.tag || target.username})\n` +
    `> **Jellyfin Username:** \`${jellyfinUser.Name}\`\n` +
    `> **Jellyfin ID:** \`${jellyfinUser.Id}\`\n` +
    `> **Status:** ${isAdminAccount ? '⚠️ Admin account — not disabled' : 'Disabled (no days added yet)'}\n` +
    (jellyseerrId ? `> **Jellyseerr User ID:** \`${jellyseerrId}\`` : `> **Jellyseerr:** Import failed or unavailable`)
  );

  await auditLog(interaction.client, {
    action: 'account_linked',
    discordId: target.id,
    discordName: target.tag || target.username,
    detail: `Jellyfin username: \`${jellyfinUser.Name}\` (ID: ${jellyfinUser.Id})${jellyseerrId ? ` | Jellyseerr ID: ${jellyseerrId}` : ''}${isAdminAccount ? ' | Admin account — not disabled' : ''}`,
    actor: interaction.user.username,
  });

  db.addSubHistory({
    discordId: target.id,
    discordName: target.tag || target.username,
    event: 'account_linked',
    reason: 'Linked to existing Jellyfin account via /manage link',
    actor: interaction.user.username,
  });

  await interaction.editReply(
    `✅ Linked existing Jellyfin account **\`${jellyfinUser.Name}\`** to **${target.username}**.\n` +
    (isAdminAccount
      ? `• ⚠️ Admin account detected — account was **not disabled**.`
      : `• Account is **disabled** until you run \`/manage adddays\`.`)
  );
}

async function handleAddDaysAll(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const days = interaction.options.getInteger('days');
  const reason = interaction.options.getString('reason');

  const activeUsers = db.getActiveSubscribers();
  if (activeUsers.length === 0) {
    return interaction.editReply('❌ No active subscribers found to add days to.');
  }

  const succeeded = [];
  const failed = [];

  for (const user of activeUsers) {
    try {
      const oldExpiry = user.expiry_date;
      const newExpiry = db.addDays(user.discord_id, days);

      // DM the user explaining the bonus days
      try {
        const member = await interaction.client.users.fetch(user.discord_id);
        await member.send(
          `🎁 **${days} day(s) have been added to your Jellyfin subscription!**\n\n` +
          `> **Reason:** ${reason}\n` +
          `> **New expiry:** ${formatDate(newExpiry)}\n\n` +
          `Thank you for your patience!`
        );
      } catch (dmErr) {
        console.warn(`[adddaysall] Could not DM ${user.discord_name}:`, dmErr.message);
      }

      db.addSubHistory({
        discordId: user.discord_id,
        discordName: user.discord_name,
        event: 'days_added_all',
        days,
        oldExpiry,
        newExpiry,
        reason,
        actor: interaction.user.username,
      });

      succeeded.push(user.discord_name);
    } catch (err) {
      console.error(`[adddaysall] Failed for ${user.discord_name}:`, err.message);
      failed.push(user.discord_name);
    }
  }

  await auditLog(interaction.client, {
    action: 'days_added_all',
    detail: `+${days} day(s) to ${succeeded.length} user(s) | Reason: ${reason}${failed.length ? ` | Failed: ${failed.join(', ')}` : ''}`,
    actor: interaction.user.username,
  });

  let reply =
    `✅ Added **${days} day(s)** to **${succeeded.length}** active subscriber(s).\n` +
    `> **Reason:** ${reason}`;
  if (failed.length > 0) {
    reply += `\n⚠️ Failed for: ${failed.join(', ')}`;
  }

  await interaction.editReply(reply);
}

async function handleSyncCheck(interaction) {
  await interaction.deferReply(EPHEMERAL);

  // Fetch all Jellyfin users and all DB users
  let jellyfinUsers;
  try {
    jellyfinUsers = await jellyfin.listUsers();
  } catch (err) {
    console.error('[synccheck] Jellyfin listUsers error:', err?.response?.data ?? err.message);
    return interaction.editReply(`❌ Failed to fetch Jellyfin users: \`${err?.response?.data?.Message ?? err.message}\``);
  }

  const dbUsers = db.getAllUsers('all');

  const jellyfinById = new Map(jellyfinUsers.map(u => [u.Id, u]));
  const dbByJellyfinId = new Map(dbUsers.filter(u => u.jellyfin_id).map(u => [u.jellyfin_id, u]));

  const issues = [];

  // 1. DB users pointing to a Jellyfin ID that doesn't exist
  for (const dbUser of dbUsers) {
    if (!dbUser.jellyfin_id) {
      issues.push(`⚠️ **${dbUser.discord_name}** — no Jellyfin ID in DB`);
      continue;
    }
    if (!jellyfinById.has(dbUser.jellyfin_id)) {
      issues.push(`❌ <@${dbUser.discord_id}> \`${dbUser.username}\` — Jellyfin account missing (ID: \`${dbUser.jellyfin_id}\`)`);
      continue;
    }
    // 2. is_active in DB disagrees with IsDisabled in Jellyfin
    const jfUser = jellyfinById.get(dbUser.jellyfin_id);
    const jfDisabled = jfUser.Policy?.IsDisabled ?? false;
    const dbActive = dbUser.is_active === 1;
    if (dbActive && jfDisabled) {
      issues.push(`🔴 <@${dbUser.discord_id}> \`${dbUser.username}\` — DB says active, Jellyfin says disabled`);
    } else if (!dbActive && !jfDisabled) {
      issues.push(`🟢 <@${dbUser.discord_id}> \`${dbUser.username}\` — DB says disabled, Jellyfin says enabled`);
    }
  }

  // 3. Jellyfin accounts that have no matching DB record
  for (const jfUser of jellyfinUsers) {
    if (!dbByJellyfinId.has(jfUser.Id)) {
      issues.push(`👻 \`${jfUser.Name}\` (ID: \`${jfUser.Id}\`) — in Jellyfin but not in DB (orphan)`);
    }
  }

  await auditLog(interaction.client, {
    action: 'sync_check_run',
    detail: `Found ${issues.length} issue(s)`,
    actor: interaction.user.username,
  });

  if (issues.length === 0) {
    return interaction.editReply('✅ Sync check complete — no issues found. Jellyfin and DB are in sync.');
  }

  let description = issues.join('\n');
  if (description.length > 4000) {
    description = description.slice(0, 4000) + `\n…(truncated, ${issues.length} total issues)`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`Sync Check — ${issues.length} Issue(s) Found`)
    .setDescription(description)
    .setColor(0xFEE75C)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleHistory(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const target = interaction.options.getUser('user');
  const user = db.getUser(target.id);

  if (!user) {
    return interaction.editReply(`❌ No account found for **${target.username}**.`);
  }

  const history = db.getSubHistory(target.id, 25);

  if (history.length === 0) {
    return interaction.editReply(`No subscription history found for **${target.username}**.`);
  }

  const EVENT_LABELS = {
    account_created:  '🆕 Account Created',
    account_linked:   '🔗 Account Linked',
    activated:        '✅ First Activation',
    days_added:       '➕ Days Added',
    days_added_all:   '🎁 Days Added (All Users)',
    days_removed:     '➖ Days Removed',
    expired:          '🔴 Expired',
    disabled:         '🔴 Manually Disabled',
    enabled:          '🟢 Manually Enabled',
  };

  const lines = history.map(e => {
    const label = EVENT_LABELS[e.event] ?? `📋 ${e.event}`;
    const ts = new Date(e.timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    let line = `**${label}** — ${ts}`;
    if (e.days !== null) line += ` | \`${e.days > 0 ? '+' : ''}${e.days}d\``;
    if (e.new_expiry) line += ` → expires ${formatDate(e.new_expiry)}`;
    if (e.reason) line += `\n> _${e.reason}_`;
    if (e.actor) line += ` _(by ${e.actor})_`;
    return line;
  });

  let description = lines.join('\n\n');
  if (description.length > 4000) {
    description = description.slice(0, 4000) + '\n…(truncated)';
  }

  const embed = new EmbedBuilder()
    .setTitle(`Subscription History — ${target.username}`)
    .setThumbnail(target.displayAvatarURL())
    .setDescription(description)
    .setColor(0x5865F2)
    .setFooter({ text: `Showing last ${history.length} event(s)` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleExportDb(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const data = db.exportData();
  const json = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(json, 'utf8');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `jellyfin-bot-backup-${timestamp}.json`;

  await auditLog(interaction.client, {
    action: 'db_exported',
    detail: `${data.users.length} user(s), ${data.audit_log.length} audit entries, ${data.subscription_history.length} history entries`,
    actor: interaction.user.username,
  });

  await interaction.editReply({
    content:
      `✅ Database exported.\n` +
      `• **${data.users.length}** user(s)\n` +
      `• **${data.audit_log.length}** audit log entries\n` +
      `• **${data.subscription_history.length}** history entries`,
    files: [{ attachment: buffer, name: filename }],
  });
}

async function handleImportDb(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const attachment = interaction.options.getAttachment('backup');

  if (!attachment.name?.endsWith('.json')) {
    return interaction.editReply('❌ Please attach a valid `.json` backup file exported by this bot.');
  }

  // Fetch the file from Discord's CDN
  const axios = require('axios');
  let data;
  try {
    const response = await axios.get(attachment.url, { responseType: 'text', timeout: 15_000 });
    data = JSON.parse(response.data);
  } catch (err) {
    return interaction.editReply(`❌ Failed to fetch or parse the backup file: \`${err.message}\``);
  }

  // Basic structure validation
  if (!Array.isArray(data.users) || !Array.isArray(data.audit_log) || !Array.isArray(data.subscription_history)) {
    return interaction.editReply('❌ Invalid backup format — missing one or more required tables (`users`, `audit_log`, `subscription_history`).');
  }

  try {
    db.importData(data);
  } catch (err) {
    console.error('[importdb] Error during import:', err.message);
    return interaction.editReply(`❌ Import failed: \`${err.message}\``);
  }

  await auditLog(interaction.client, {
    action: 'db_imported',
    detail: `Restored ${data.users.length} user(s), ${data.audit_log.length} audit entries, ${data.subscription_history.length} history entries | backup exported at ${data.exportedAt ?? 'unknown'}`,
    actor: interaction.user.username,
  });

  await interaction.editReply(
    `✅ Database import complete.\n` +
    `• **${data.users.length}** user(s) restored\n` +
    `• **${data.audit_log.length}** audit log entries restored\n` +
    `• **${data.subscription_history.length}** history entries restored\n` +
    (data.exportedAt ? `• Backup was taken at: \`${data.exportedAt}\`` : '')
  );
}

// ─── Command definition ───────────────────────────────────────────────────────

const userOption = (b) =>
  b.setName('user').setDescription('The Discord user to manage').setRequired(true);

const daysOption = (b) =>
  b.setName('days').setDescription('Number of days').setRequired(true).setMinValue(1);

const reasonOption = (b, required = false) =>
  b.setName('reason').setDescription('Optional reason (stored in history and audit log)').setRequired(required);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('manage')
    .setDescription('(Owner only) Manage a Jellyfin subscriber')
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Create Jellyfin + Jellyseerr account for a user')
        .addUserOption(userOption))
    .addSubcommand(sub =>
      sub.setName('adddays')
        .setDescription('Add subscription days to a user')
        .addUserOption(userOption)
        .addIntegerOption(daysOption)
        .addStringOption(opt => reasonOption(opt, true)))
    .addSubcommand(sub =>
      sub.setName('removedays')
        .setDescription('Remove subscription days from a user')
        .addUserOption(userOption)
        .addIntegerOption(daysOption)
        .addStringOption(opt => reasonOption(opt, true)))
    .addSubcommand(sub =>
      sub.setName('info')
        .setDescription('Show account info for a user')
        .addUserOption(userOption))
    .addSubcommand(sub =>
      sub.setName('disable')
        .setDescription('Manually disable a user\'s Jellyfin account')
        .addUserOption(userOption))
    .addSubcommand(sub =>
      sub.setName('enable')
        .setDescription('Manually enable a user\'s Jellyfin account')
        .addUserOption(userOption))
    .addSubcommand(sub =>
      sub.setName('resetpassword')
        .setDescription('Generate and set a new password for a user (DM\'d to you)')
        .addUserOption(userOption))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Delete a user\'s Jellyfin account and remove from DB')
        .addUserOption(userOption))
    .addSubcommand(sub =>
      sub.setName('reset')
        .setDescription('Full wipe: delete Jellyfin account, DB record, and Discord role (useful for testing)')
        .addUserOption(userOption))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List all Jellyfin subscribers')
        .addStringOption(opt =>
          opt.setName('filter')
            .setDescription('Filter users to show')
            .addChoices(
              { name: 'All',            value: 'all' },
              { name: 'Active',         value: 'active' },
              { name: 'Expired',        value: 'expired' },
              { name: 'Expiring Soon',  value: 'expiring-soon' },
            )))
    .addSubcommand(sub =>
      sub.setName('stats')
        .setDescription('Show subscriber statistics'))
    .addSubcommand(sub =>
      sub.setName('synccheck')
        .setDescription('Compare Jellyfin accounts vs DB and report any mismatches'))
    .addSubcommand(sub =>
      sub.setName('history')
        .setDescription('Show subscription history for a user')
        .addUserOption(userOption))
    .addSubcommand(sub =>
      sub.setName('link')
        .setDescription('Link an existing Jellyfin account to a Discord user')
        .addUserOption(userOption)
        .addStringOption(opt =>
          opt.setName('jellyfin-username')
            .setDescription('Exact Jellyfin username of the existing account')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('adddaysall')
        .setDescription('Add days to every currently active subscriber (e.g. for downtime compensation)')
        .addIntegerOption(daysOption)
        .addStringOption(opt =>
          opt.setName('reason')
            .setDescription('Reason to include in the DM sent to each user')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('exportdb')
        .setDescription('Export the full database as a JSON backup file (sent as a file attachment)'))
    .addSubcommand(sub =>
      sub.setName('importdb')
        .setDescription('⚠️ Overwrite the database from a JSON backup file (irreversible)')
        .addAttachmentOption(opt =>
          opt.setName('backup')
            .setDescription('The .json file exported by /manage exportdb')
            .setRequired(true))),

  async execute(interaction) {
    if (!isOwner(interaction)) {
      return interaction.reply({ content: '❌ You are not authorized to use this command.', ...EPHEMERAL });
    }

    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case 'setup':         return handleSetup(interaction);
      case 'adddays':       return handleAddDays(interaction);
      case 'removedays':    return handleRemoveDays(interaction);
      case 'info':          return handleInfo(interaction);
      case 'disable':       return handleDisable(interaction);
      case 'enable':        return handleEnable(interaction);
      case 'resetpassword': return handleResetPassword(interaction);
      case 'remove':        return handleRemove(interaction);
      case 'reset':         return handleReset(interaction);
      case 'list':          return handleList(interaction);
      case 'stats':         return handleStats(interaction);
      case 'link':          return handleLink(interaction);
      case 'adddaysall':    return handleAddDaysAll(interaction);
      case 'synccheck':     return handleSyncCheck(interaction);
      case 'history':       return handleHistory(interaction);
      case 'exportdb':      return handleExportDb(interaction);
      case 'importdb':      return handleImportDb(interaction);
      default:
        return interaction.reply({ content: '❌ Unknown subcommand.', ...EPHEMERAL });
    }
  },
};
