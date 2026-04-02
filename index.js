require('dotenv').config();

const { Client, GatewayIntentBits, Collection, REST, Routes, ActivityType } = require('discord.js');
const { startExpiryScheduler } = require('./tasks/expiry');
const jellyfin = require('./api/jellyfin');
const db = require('./database');

// ─── Load commands ─────────────────────────────────────────────────────────────
const manageCommand = require('./commands/manage');
const meCommand = require('./commands/me');
const setupCommand = require('./commands/setup');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection();
client.commands.set(manageCommand.data.name, manageCommand);
client.commands.set(meCommand.data.name, meCommand);
client.commands.set(setupCommand.data.name, setupCommand);

// ─── Register slash commands ───────────────────────────────────────────────────
async function registerCommands() {
  const { DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID } = process.env;

  if (!DISCORD_CLIENT_ID) {
    console.warn('⚠️  DISCORD_CLIENT_ID not set — skipping command registration.');
    return;
  }

  const rest = new REST().setToken(DISCORD_TOKEN);
  const body = [manageCommand.data.toJSON(), meCommand.data.toJSON(), setupCommand.data.toJSON()];

  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body });
      console.log(`✅ Slash commands registered to guild ${GUILD_ID}.`);
    } else {
      await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body });
      console.log('✅ Slash commands registered globally (may take up to 1 hour to appear).');
    }
  } catch (err) {
    console.error('❌ Failed to register slash commands:', err?.message ?? err);
  }
}

// ─── Status rotation ───────────────────────────────────────────────────────────
async function updateStatus(client) {
  try {
    const [counts, stats] = await Promise.allSettled([
      jellyfin.getItemCounts(),
      Promise.resolve(db.getStats()),
    ]);

    const movies   = counts.status === 'fulfilled' ? counts.value.MovieCount   ?? 0 : null;
    const series   = counts.status === 'fulfilled' ? counts.value.SeriesCount  ?? 0 : null;
    const episodes = counts.status === 'fulfilled' ? counts.value.EpisodeCount ?? 0 : null;
    const active   = stats.status  === 'fulfilled' ? stats.value.active        ?? 0 : null;

    const options = [
      movies   !== null ? { type: ActivityType.Watching, name: `${movies.toLocaleString()} movies` }         : null,
      series   !== null ? { type: ActivityType.Watching, name: `${series.toLocaleString()} TV shows` }       : null,
      episodes !== null ? { type: ActivityType.Watching, name: `${episodes.toLocaleString()} episodes` }     : null,
      active   !== null ? { type: ActivityType.Watching, name: `${active} active subscriber(s)` }            : null,
    ].filter(Boolean);

    if (options.length === 0) return;

    const pick = options[Math.floor(Math.random() * options.length)];
    client.user.setActivity(pick.name, { type: pick.type });
  } catch (err) {
    console.warn('[status] Failed to update bot status:', err.message);
  }
}

function startStatusRotation(client) {
  // Update immediately, then every 5 minutes
  updateStatus(client);
  setInterval(() => updateStatus(client), 5 * 60 * 1000);
}

// ─── Events ───────────────────────────────────────────────────────────────────
client.once('clientReady', async (readyClient) => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);
  await registerCommands();
  startExpiryScheduler(client);
  startStatusRotation(client);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[command:${interaction.commandName}]`, err);

    const msg = { content: '❌ An error occurred while running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
