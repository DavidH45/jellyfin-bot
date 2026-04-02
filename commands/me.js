const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const db = require('../database');
const jellyfin = require('../api/jellyfin');

function formatDate(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'UTC',
  });
}

function daysRemaining(iso) {
  if (!iso) return null;
  const diff = new Date(iso) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

/**
 * Build a text progress bar representing how much subscription time remains.
 * Uses the account creation date as the "start" of the current period, and
 * the expiry date as the "end". Falls back gracefully if history is incomplete.
 */
function buildExpiryBar(createdAt, expiryDate, totalBars = 20) {
  if (!expiryDate) return null;
  const now = Date.now();
  const end = new Date(expiryDate).getTime();
  const start = createdAt ? new Date(createdAt).getTime() : now;
  const total = end - start;
  if (total <= 0) return '░'.repeat(totalBars); // already expired
  const elapsed = now - start;
  const ratio = Math.min(1, Math.max(0, elapsed / total));
  const filled = Math.round((1 - ratio) * totalBars);
  return '█'.repeat(filled) + '░'.repeat(totalBars - filled);
}

/** Generate a random alphanumeric password */
function generatePassword(length = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function handleStatus(interaction) {
  const user = db.getUser(interaction.user.id);

  if (!user) {
    return interaction.reply({
      content: '❌ You don\'t have a Jellyfin account linked to your Discord. Contact the server owner.',
      ...EPHEMERAL,
    });
  }

  const remaining = daysRemaining(user.expiry_date);
  const statusEmoji = user.is_active ? '🟢' : '🔴';
  const statusText = user.is_active ? 'Active' : 'Disabled';

  let remainingText = 'N/A';
  let color = 0xED4245; // red for disabled

  if (user.is_active && remaining !== null) {
    if (remaining <= 7) {
      color = 0xFEE75C; // yellow warning
      remainingText = `⚠️ **${remaining} day(s)** — expiring soon!`;
    } else {
      color = 0x57F287; // green healthy
      remainingText = `${remaining} day(s)`;
    }
  } else if (!user.is_active) {
    remainingText = 'Account disabled';
  }

  const embed = new EmbedBuilder()
    .setTitle('Your Jellyfin Subscription')
    .setColor(color)
    .setThumbnail(interaction.user.displayAvatarURL())
    .addFields(
      { name: 'Jellyfin Username', value: `\`${user.username}\``, inline: true },
      { name: 'Status', value: `${statusEmoji} ${statusText}`, inline: true },
      { name: '\u200B', value: '\u200B', inline: true }, // spacer
      { name: 'Expiry Date', value: formatDate(user.expiry_date), inline: true },
      { name: 'Days Remaining', value: remainingText, inline: true },
    );

  // Expiry progress bar — only shown when subscription is active
  if (user.is_active && user.expiry_date) {
    const bar = buildExpiryBar(user.created_at, user.expiry_date);
    if (bar) {
      embed.addFields({ name: 'Time Remaining', value: `\`${bar}\``, inline: false });
    }
  }

  embed
    .setFooter({ text: 'Contact the server owner to renew your subscription.' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ...EPHEMERAL });
}

async function handleResetPassword(interaction) {
  await interaction.deferReply(EPHEMERAL);

  const user = db.getUser(interaction.user.id);

  if (!user) {
    return interaction.editReply('❌ You don\'t have a Jellyfin account linked to your Discord. Contact the server owner.');
  }

  const newPassword = generatePassword();

  try {
    await jellyfin.setPassword(user.jellyfin_id, newPassword);
  } catch (err) {
    console.error('[me:resetpassword] Jellyfin setPassword error:', err?.response?.data ?? err.message);
    return interaction.editReply('❌ Failed to reset your password. Please try again or contact the server owner.');
  }

  try {
    await interaction.user.send(
      `🔑 **Your Jellyfin password has been reset.**\n\n` +
      `> **Username:** \`${user.username}\`\n` +
      `> **New Password:** \`${newPassword}\`\n\n` +
      `Server URL: ${process.env.JELLYFIN_URL}`
    );
    await interaction.editReply('✅ Your password has been reset. **Check your DMs** for the new credentials.');
  } catch (err) {
    // If DM fails, fall back to sending credentials ephemerally in the interaction
    console.warn('[me:resetpassword] Could not DM user, responding ephemerally:', err.message);
    await interaction.editReply(
      `✅ Your password has been reset.\n\n` +
      `> **Username:** \`${user.username}\`\n` +
      `> **New Password:** \`${newPassword}\`\n\n` +
      `*(Could not send DM — screenshot this message before dismissing it.)*`
    );
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('me')
    .setDescription('Manage your Jellyfin account')
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Check your Jellyfin subscription status'))
    .addSubcommand(sub =>
      sub.setName('resetpassword')
        .setDescription('Reset your Jellyfin password (new password sent via DM)')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case 'status':        return handleStatus(interaction);
      case 'resetpassword': return handleResetPassword(interaction);
      default:
        return interaction.reply({ content: '❌ Unknown subcommand.', ...EPHEMERAL });
    }
  },
};

