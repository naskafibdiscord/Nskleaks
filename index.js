require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, ChannelType, EmbedBuilder, AttachmentBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const IMAGE_FILE = path.join(__dirname, 'assets', 'IMG_0903.jpeg');

// ---------- Config (par serveur) ----------
const loadConfig = () => (fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {});
const saveConfig = (c) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));

// Catégories du menu "Fais un choix"
const CATEGORIES = [
  { label: 'Support', value: 'support', emoji: '🛠️', description: "Besoin d'aide ou d'un renseignement" },
  { label: 'Achat / Premium', value: 'achat', emoji: '💎', description: 'Question sur un achat ou un accès' },
  { label: 'Partenariat', value: 'partenariat', emoji: '🤝', description: 'Proposer un partenariat' },
  { label: 'Signalement', value: 'signalement', emoji: '🚨', description: 'Signaler un problème ou un membre' },
  { label: 'Autre', value: 'autre', emoji: '📩', description: 'Toute autre demande' },
];

// ---------- Client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

// ---------- Commande /ticket ----------
const ticketCommand = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Configurer et envoyer le panneau de tickets')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addRoleOption((o) => o.setName('staff').setDescription('Rôle du staff qui gère les tickets').setRequired(true))
  .addChannelOption((o) =>
    o.setName('salon').setDescription('Salon où envoyer le panneau (par défaut : salon actuel)')
      .addChannelTypes(ChannelType.GuildText))
  .addStringOption((o) => o.setName('titre').setDescription('Titre du panneau (défaut : Tickets)'))
  .addStringOption((o) =>
    o.setName('description').setDescription('Description du panneau'))
  .addChannelOption((o) =>
    o.setName('logs').setDescription('Salon de logs des tickets (optionnel)')
      .addChannelTypes(ChannelType.GuildText));

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [ticketCommand.toJSON()] });
  console.log(`✅ ${client.user.tag} est en ligne (NSK Leaks)`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    // --- /ticket ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'ticket') {
      const staff = interaction.options.getRole('staff');
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      const logs = interaction.options.getChannel('logs');
      const titre = interaction.options.getString('titre') || 'Tickets';
      const description =
        interaction.options.getString('description') || 'Utilisez ce menu pour créer un ticket et contacter le staff';

      const config = loadConfig();
      config[interaction.guildId] = { staffRoleId: staff.id, panelChannelId: channel.id, logsChannelId: logs?.id || null };
      saveConfig(config);

      const image = new AttachmentBuilder(IMAGE_FILE, { name: 'ticket.jpg' });
      const embed = new EmbedBuilder()
        .setTitle(titre)
        .setDescription(description)
        .setColor(0x57f287)
        .setImage('attachment://ticket.jpg');

      const menu = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ticket_select')
          .setPlaceholder('Fais un choix')
          .addOptions(CATEGORIES),
      );

      await channel.send({ embeds: [embed], components: [menu], files: [image] });
      return interaction.reply({ content: `✅ Panneau envoyé dans ${channel}.`, ephemeral: true });
    }

    // --- Choix dans le menu : création du ticket (fil privé) ---
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_select') {
      const config = loadConfig()[interaction.guildId];
      if (!config) return interaction.reply({ content: "❌ Le système n'est pas configuré.", ephemeral: true });

      const cat = CATEGORIES.find((c) => c.value === interaction.values[0]);
      const channel = interaction.channel;

      // Réinitialise le menu pour pouvoir re-choisir
      await interaction.message.edit({ components: interaction.message.components }).catch(() => {});

      // Un seul ticket ouvert par membre
      const active = await channel.threads.fetchActive();
      const existing = active.threads.find((t) => t.name.endsWith(`-${interaction.user.id}`));
      if (existing) {
        return interaction.reply({ content: `❌ Tu as déjà un ticket ouvert : ${existing}`, ephemeral: true });
      }

      const thread = await channel.threads.create({
        name: `${cat.value}-${interaction.user.username}-${interaction.user.id}`.slice(0, 100),
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: `Ticket de ${interaction.user.tag}`,
      });
      await thread.members.add(interaction.user.id);

      const embed = new EmbedBuilder()
        .setTitle(`${cat.emoji} Ticket — ${cat.label}`)
        .setDescription(`Bienvenue ${interaction.user}, explique ta demande.\nUn membre du staff te répondra rapidement.`)
        .setColor(0x57f287)
        .setTimestamp();

      const close = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('Fermer le ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      );

      // La mention du rôle staff les ajoute automatiquement au fil
      await thread.send({
        content: `${interaction.user} <@&${config.staffRoleId}>`,
        embeds: [embed],
        components: [close],
      });

      return interaction.reply({ content: `✅ Ticket créé : ${thread}`, ephemeral: true });
    }

    // --- Fermeture ---
    if (interaction.isButton() && interaction.customId === 'ticket_close') {
      const config = loadConfig()[interaction.guildId];
      const isStaff = interaction.member.roles.cache.has(config?.staffRoleId);
      const isOwner = interaction.channel.name.endsWith(`-${interaction.user.id}`);
      if (!isStaff && !isOwner) {
        return interaction.reply({ content: "❌ Tu ne peux pas fermer ce ticket.", ephemeral: true });
      }

      await interaction.reply('🔒 Ticket fermé, suppression dans 5 secondes...');

      if (config?.logsChannelId) {
        const logCh = await interaction.guild.channels.fetch(config.logsChannelId).catch(() => null);
        logCh?.send({
          embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Ticket fermé')
            .setDescription(`**Ticket :** ${interaction.channel.name}\n**Fermé par :** ${interaction.user}`).setTimestamp()],
        });
      }
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    }
  } catch (err) {
    console.error(err);
    const msg = { content: '❌ Une erreur est survenue.', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

// Mini serveur web (nécessaire pour Render gratuit en "Web Service")
require('http')
  .createServer((req, res) => res.end('NSK Leaks en ligne'))
  .listen(process.env.PORT || 3000);

client.login(process.env.TOKEN);
