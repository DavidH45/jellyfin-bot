const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const db = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Get your Jellyfin server URL and app download links'),

  async execute(interaction) {
    const user = db.getUser(interaction.user.id);

    if (!user) {
      return interaction.reply({
        content: '❌ You don\'t have a Jellyfin account linked to your Discord yet. Contact the server owner.',
        ...EPHEMERAL,
      });
    }

    const serverUrl = process.env.JELLYFIN_URL ?? 'Not configured';

    const embed = new EmbedBuilder()
      .setTitle('🎬 Jellyfin Setup Guide')
      .setColor(0x00A4DC) // Jellyfin brand blue
      .setDescription(
        `Welcome, **${interaction.user.username}**! Here's everything you need to get set up.\n\n` +
        `**Your Jellyfin username:** \`${user.username}\`\n` +
        `**Server URL:** ${serverUrl}\n\n` +
        `Download the Jellyfin app for your device below, then log in with your credentials.\n` +
        `If you need your password, use \`/me resetpassword\`.`
      )
      .addFields(
        {
          name: '📱 iOS (iPhone / iPad)',
          value: '[Jellyfin for iOS — App Store](https://apps.apple.com/us/app/jellyfin-mobile/id1480192618)',
          inline: false,
        },
        {
          name: '🤖 Android',
          value: '[Jellyfin for Android — Google Play](https://play.google.com/store/apps/details?id=org.jellyfin.mobile)',
          inline: false,
        },
        {
          name: '📺 Android TV / Google TV',
          value: '[Jellyfin for Android TV — Google Play](https://play.google.com/store/apps/details?id=org.jellyfin.androidtv)',
          inline: false,
        },
        {
          name: '🍎 Apple TV (tvOS)',
          value: '[Jellyfin for Apple TV — App Store](https://apps.apple.com/us/app/jellyfin-mobile/id1480192618)\n_Search "Jellyfin" in the tvOS App Store_',
          inline: false,
        },
        {
          name: '🖥️ Web Browser',
          value: `[Open in Browser](${serverUrl})`,
          inline: false,
        },
        {
          name: '🪟 Windows / macOS / Linux',
          value: '[Jellyfin Media Player — GitHub Releases](https://github.com/jellyfin/jellyfin-media-player/releases/latest)',
          inline: false,
        },
        {
          name: '🔥 Amazon Fire TV / Fire Stick',
          value: '[Jellyfin for Fire TV — Amazon Appstore](https://www.amazon.com/Jellyfin/dp/B07TX7Z725)',
          inline: false,
        },
        {
          name: '📡 Roku',
          value: '[Jellyfin for Roku — Roku Channel Store](https://channelstore.roku.com/details/592369/jellyfin)',
          inline: false,
        },
      )
      .setFooter({ text: 'Need help? Contact the server owner.' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ...EPHEMERAL });
  },
};
