require('dotenv').config();

const { REST, Routes } = require('discord.js');
const manageCommand = require('./commands/manage');
const meCommand = require('./commands/me');

const commands = [
  manageCommand.data.toJSON(),
  meCommand.data.toJSON(),
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  const { DISCORD_CLIENT_ID, GUILD_ID } = process.env;

  if (!DISCORD_CLIENT_ID) {
    console.error('❌ DISCORD_CLIENT_ID is not set in .env');
    process.exit(1);
  }

  try {
    if (GUILD_ID) {
      // Guild-scoped: instant registration, great for development
      console.log(`Registering ${commands.length} command(s) to guild ${GUILD_ID}...`);
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: commands });
      console.log('✅ Guild commands registered.');
    } else {
      // Global: takes up to 1 hour to propagate — use for production
      console.log(`Registering ${commands.length} command(s) globally...`);
      await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
      console.log('✅ Global commands registered (may take up to 1 hour to appear).');
    }
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
    process.exit(1);
  }
})();
