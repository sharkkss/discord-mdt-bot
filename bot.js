// ￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣
// 🎉 MDT BOT (Fancy + Emoji Edition) — Public + Persistent + Secure
// ￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣
// What’s included:
// - Public (non-ephemeral) previews/results for /mdt and /officerstats
// - Persistent case numbers per day & report type (reads latest from Google Sheets)
// - ✏️ Edit Modal: fix fields before confirming
// - Role & channel guard (fill the arrays below)
// - Per-user draft sessions (no cross-user collisions)
// - Rich embeds, presence, PH timezone
// ￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣

// ------------------ 🚦 KEEP-ALIVE SERVER ------------------
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (_req, res) => res.send('✅ Bot is running — MDT Ready!'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.listen(port, () => console.log(`🛰️  Keep-alive: listening on port ${port}`));

// ------------------ 🤖 DISCORD + 📗 GOOGLE SHEETS SETUP ------------------
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} = require('discord.js');
const { google } = require('googleapis');

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in environment.');
  process.exit(1);
}
if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
  console.error('❌ Missing GOOGLE_SHEETS_CREDENTIALS in environment.');
  process.exit(1);
}

const googleCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);

// ⚙️ App + guild config
const clientId = '1437985374398840873';
const guildIds = [
  '1024627335707762688', // 🧪 test server
  '1072289637000814632', // 🧪 second server
];

// ✅ Role/Channel Guard — fill with your real IDs
const ALLOWED_ROLES = [/* '123456789012345678' */];
const ALLOWED_CHANNELS = [/* '234567890123456789' */];

// 📄 Sheets API
const sheets = google.sheets('v4');
const spreadsheetId = '1VrYFm0EquJGNkyqo1OuLUWEUtPmnU1_B0cWZ0t1g7n8';
const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// 🤝 Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// 🗂️ Per-user session drafts (guild-scoped)
const sessions = new Map(); // key: `${userId}:${guildId}` -> { draft }

const sessionKey = (interaction) => `${interaction.user?.id || 'user'}:${interaction.guildId || 'DM'}`;

// 🧮 Helpers
const tz = 'Asia/Manila';
const nowPH = () => new Date().toLocaleString('en-PH', { timeZone: tz });
const datePH = () => new Date().toLocaleDateString('en-PH', { timeZone: tz });
const yyyymmddPH = () => {
  const d = new Date();
  const y = d.toLocaleString('en-PH', { timeZone: tz, year: 'numeric' });
  const m = d.toLocaleString('en-PH', { timeZone: tz, month: '2-digit' });
  const da = d.toLocaleString('en-PH', { timeZone: tz, day: '2-digit' });
  return `${y}${m}${da}`;
};

// 🔢 Compute next case number by scanning the date-prefixed entries
async function getNextCaseSeq(type) {
  const authClient = await auth.getClient();
  const prefix = type === 'Arrest Log' ? 'AL' : 'IR';
  const range = type === 'Arrest Log' ? 'Arrest Log!A2:A' : 'Incident Report!A2:A';
  const day = yyyymmddPH();
  const start = `${prefix}-${day}-`;

  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range, auth: authClient });
  const rows = res.data.values || [];
  const seqs = rows
    .map(r => (r && r[0]) || '')
    .filter(v => typeof v === 'string' && v.startsWith(start))
    .map(v => {
      const n = parseInt(v.split('-').pop(), 10);
      return Number.isFinite(n) ? n : NaN;
    })
    .filter(Number.isFinite);

  const maxSeq = seqs.length ? Math.max(...seqs) : 999; // start from 1000 if none
  return maxSeq + 1;
}

// 🧱 Shared UI builders
function buildMdtEmbed(draft, user) {
  const embed = new EmbedBuilder()
    .setColor(0x00a3ff)
    .setTitle(`${draft.type === 'Arrest Log' ? '🚔 Arrest Log' : '📝 Incident Report'} — Review & Confirm`)
    .setAuthor({
      name: `${user.username} • ${nowPH()} (PH)`,
      iconURL: user.displayAvatarURL({ forceStatic: false }),
    })
    .addFields(
      { name: '🆔 Case Number', value: `**${draft.caseNum}**`, inline: true },
      { name: '📅 Date', value: draft.date, inline: true },
      { name: '👮 Officer', value: draft.officer, inline: true },
      { name: '🧍 Suspect', value: draft.suspect, inline: true },
      { name: '⚖️ Charge / Incident', value: draft.charge, inline: true },
      { name: '📍 Location', value: draft.location, inline: true },
      { name: '🧾 Evidence', value: draft.evidence || '—', inline: false },
      { name: '🗒️ Summary', value: draft.summary || 'No summary provided', inline: false },
    )
    .setFooter({ text: '✅ Confirm to log to Google Sheets • ✏️ Edit to fix • ❌ Cancel to discard' })
    .setTimestamp();

  if (draft.evidenceImage?.url) {
    embed.setImage(draft.evidenceImage.url);
  }
  return embed;
}

function buildMdtButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm_mdt').setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('edit_mdt').setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cancel_mdt').setLabel('Cancel').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
}

// ------------------ 🚀 BOT READY EVENT ------------------
client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag} | 🕒 ${nowPH()} (PH)`);

  // 🟩 Presence
  client.user.setPresence({
    activities: [{ name: '🚓 MDT on duty | /mdt', type: 0 }],
    status: 'online',
  });

  // 🛠️ Slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('mdt')
      .setDescription('🚓 Start the MDT process')
      .addStringOption((opt) =>
        opt
          .setName('type')
          .setDescription('Type of report')
          .setRequired(true)
          .addChoices(
            { name: 'Arrest Log', value: 'Arrest Log' },
            { name: 'Incident Report', value: 'Incident Report' },
          ),
      )
      .addStringOption((opt) => opt.setName('officer').setDescription('Officer name').setRequired(true))
      .addStringOption((opt) => opt.setName('suspect').setDescription('Suspect name').setRequired(true))
      .addStringOption((opt) => opt.setName('charge').setDescription('Charge or incident').setRequired(true))
      .addStringOption((opt) => opt.setName('location').setDescription('Location').setRequired(true))
      .addStringOption((opt) => opt.setName('evidence').setDescription('Evidence details').setRequired(true))
      .addStringOption((opt) => opt.setName('summary').setDescription('Summary or note').setRequired(false))
      .addAttachmentOption((opt) => opt.setName('evidenceimage').setDescription('Evidence image')),

    new SlashCommandBuilder()
      .setName('officerstats')
      .setDescription('📊 View officer stats')
      .addStringOption((opt) => opt.setName('officer').setDescription('Officer name').setRequired(true)),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  for (const id of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, id), { body: commands });
      console.log(`🧭 Commands registered for guild ${id} ✅`);
    } catch (err) {
      console.error(`🚨 Failed to register commands for ${id}:`, err);
    }
  }
});

// ------------------ 🧩 INTERACTION HANDLER ------------------
client.on('interactionCreate', async (interaction) => {
  try {
    // ---------- ⌨️ SLASH COMMANDS ----------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      // Role/Channel guard (commands only)
      if (ALLOWED_CHANNELS.length && !ALLOWED_CHANNELS.includes(interaction.channelId)) {
        const hint = ALLOWED_CHANNELS.map(id => `<#${id}>`).join(', ');
        return interaction.reply({ content: `🔒 Please use this in: ${hint}`, flags: MessageFlags.Ephemeral });
      }
      if (ALLOWED_ROLES.length && !interaction.member?.roles?.cache?.some(r => ALLOWED_ROLES.includes(r.id))) {
        return interaction.reply({ content: `🔒 You don't have permission to use this command.`, flags: MessageFlags.Ephemeral });
      }

      if (commandName === 'mdt') {
        // PUBLIC preview
        await interaction.deferReply();

        const type = interaction.options.getString('type');
        const officer = interaction.options.getString('officer');
        const suspect = interaction.options.getString('suspect');
        const charge = interaction.options.getString('charge');
        const location = interaction.options.getString('location');
        const evidence = interaction.options.getString('evidence');
        const summary = interaction.options.getString('summary');
        const evidenceImage = interaction.options.getAttachment('evidenceimage');

        // Persistent sequence based on current sheet contents
        const day = yyyymmddPH();
        const prefix = type === 'Arrest Log' ? 'AL' : 'IR';
        const nextSeq = await getNextCaseSeq(type);
        const caseNum = `${prefix}-${day}-${nextSeq}`;

        const draft = {
          userId: interaction.user.id,
          type,
          caseNum,
          seq: nextSeq,
          date: datePH(),
          officer: officer?.trim(),
          suspect: suspect?.trim(),
          charge: charge?.trim(),
          location: location?.trim(),
          evidence: evidence?.trim(),
          summary: (summary || '').trim(),
          evidenceImage,
          messageId: null,
        };

        // Save session
        sessions.set(sessionKey(interaction), draft);

        // Render preview
        const embed = buildMdtEmbed(draft, interaction.user);
        const buttons = buildMdtButtons();
        await interaction.editReply({ embeds: [embed], components: [buttons] });

        // Save preview message id for later edits
        try {
          const msg = await interaction.fetchReply();
          draft.messageId = msg.id;
          sessions.set(sessionKey(interaction), draft);
        } catch {}
      }

      if (commandName === 'officerstats') {
        // PUBLIC result
        await interaction.deferReply();

        const officerName = interaction.options.getString('officer');
        const authClient = await auth.getClient();
        const arrestReq = { spreadsheetId, range: 'Arrest Log!A2:I', auth: authClient };
        const incidentReq = { spreadsheetId, range: 'Incident Report!A2:I', auth: authClient };

        try {
          const [arrestRes, incidentRes] = await Promise.all([
            sheets.spreadsheets.values.get(arrestReq),
            sheets.spreadsheets.values.get(incidentReq),
          ]);

          const arrestRows = arrestRes.data.values || [];
          const incidentRows = incidentRes.data.values || [];

          const arrestCases = arrestRows.filter((r) => (r?.[2] || '').toLowerCase() === officerName.toLowerCase()).length;
          const incidentCases = incidentRows.filter((r) => (r?.[2] || '').toLowerCase() === officerName.toLowerCase()).length;
          const totalCases = arrestCases + incidentCases;

          const statsEmbed = new EmbedBuilder()
            .setColor(0x00a3ff)
            .setTitle(`📊 ${officerName}'s Stats`)
            .addFields(
              { name: '🧮 Total Cases', value: `**${totalCases}**`, inline: true },
              { name: '👮 Arrests', value: `${arrestCases}`, inline: true },
              { name: '📝 Incident Reports', value: `${incidentCases}`, inline: true },
            )
            .setFooter({ text: `Updated • ${nowPH()} (PH)` })
            .setTimestamp();

          await interaction.editReply({ embeds: [statsEmbed] });
        } catch (err) {
          console.error('🚨 Error fetching officer stats:', err);
          await interaction.editReply('❌ Error fetching officer stats. Please try again later.');
        }
      }
    }

    // ---------- 🔘 BUTTON INTERACTIONS ----------
    else if (interaction.isButton()) {
      const key = sessionKey(interaction);
      const draft = sessions.get(key);

      // Require a draft
      if (!draft) {
        return interaction.reply({ content: '⚠️ No active MDT draft found for you. Start with **/mdt**.', flags: MessageFlags.Ephemeral });
      }

      // Only the creator can act on their draft
      if (interaction.user.id !== draft.userId) {
        return interaction.reply({ content: '🚫 This draft belongs to another user.', flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'confirm_mdt') {
        // Recompute next sequence in case other reports were added meanwhile (avoid collisions)
        const nextSeq = await getNextCaseSeq(draft.type);
        const day = yyyymmddPH();
        const prefix = draft.type === 'Arrest Log' ? 'AL' : 'IR';
        draft.seq = nextSeq;
        draft.caseNum = `${prefix}-${day}-${nextSeq}`;

        const caseDataArray = [
          draft.caseNum,
          draft.date,
          draft.officer,
          draft.suspect,
          draft.charge,
          draft.location,
          draft.evidence,
          draft.summary || 'No summary provided',
          draft.evidenceImage ? draft.evidenceImage.url : 'No image provided',
        ];

        const range = draft.type === 'Arrest Log' ? 'Arrest Log!A1' : 'Incident Report!A1';

        try {
          const authClient = await auth.getClient();
          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: 'RAW',
            resource: { values: [caseDataArray] },
            auth: authClient,
          });

          // Clear session
          sessions.delete(key);

          await interaction.update({
            content: `✅ **${draft.caseNum}** logged to Google Sheets!`,
            components: [],
            embeds: [],
          });
        } catch (err) {
          console.error('🚨 Error logging MDT report:', err);
          await interaction.update({
            content: '❌ Error logging MDT report. Please check your Google credentials & spreadsheet ID.',
            components: [],
            embeds: [],
          });
        }
      }

      if (interaction.customId === 'cancel_mdt') {
        sessions.delete(key);
        await interaction.update({
          content: '❌ **MDT Report entry canceled.**',
          components: [],
          embeds: [],
        });
      }

      if (interaction.customId === 'edit_mdt') {
        // keep message id in session
        draft.messageId = interaction.message?.id || draft.messageId;
        sessions.set(key, draft);

        const modal = new ModalBuilder().setCustomId('mdt_modal').setTitle('✏️ Edit MDT Draft');

        const mkShort = (id, label, value, required = true) =>
          new TextInputBuilder()
            .setCustomId(id).setLabel(label)
            .setStyle(TextInputStyle.Short)
            .setRequired(required)
            .setValue((value || '').slice(0, 100));

        const mkLong = (id, label, value, required = false) =>
          new TextInputBuilder()
            .setCustomId(id).setLabel(label)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(required)
            .setValue((value || '').slice(0, 1024));

        modal.addComponents(
          new ActionRowBuilder().addComponents(mkShort('officer', 'Officer', draft.officer)),
          new ActionRowBuilder().addComponents(mkShort('suspect', 'Suspect', draft.suspect)),
          new ActionRowBuilder().addComponents(mkShort('charge', 'Charge / Incident', draft.charge)),
          new ActionRowBuilder().addComponents(mkShort('location', 'Location', draft.location)),
          new ActionRowBuilder().addComponents(mkLong('summary', 'Summary (optional)', draft.summary, false)),
        );

        await interaction.showModal(modal);
      }
    }

    // ---------- 📝 MODAL SUBMISSIONS ----------
    else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'mdt_modal') {
        const key = sessionKey(interaction);
        const draft = sessions.get(key);

        if (!draft) {
          return interaction.reply({ content: '⚠️ Draft not found. Please run **/mdt** again.', flags: MessageFlags.Ephemeral });
        }
        if (interaction.user.id !== draft.userId) {
          return interaction.reply({ content: '🚫 This draft belongs to another user.', flags: MessageFlags.Ephemeral });
        }

        // Update draft from modal fields
        draft.officer = interaction.fields.getTextInputValue('officer').trim();
        draft.suspect = interaction.fields.getTextInputValue('suspect').trim();
        draft.charge = interaction.fields.getTextInputValue('charge').trim();
        draft.location = interaction.fields.getTextInputValue('location').trim();
        draft.summary = interaction.fields.getTextInputValue('summary').trim();

        sessions.set(key, draft);

        // Update the original preview message
        try {
          const embed = buildMdtEmbed(draft, interaction.user);
          const buttons = buildMdtButtons();
          if (draft.messageId && interaction.channel) {
            await interaction.channel.messages.edit(draft.messageId, { embeds: [embed], components: [buttons] });
          }
        } catch (e) {
          console.error('⚠️ Failed to edit preview message:', e);
        }

        // Acknowledge modal (ephemeral to avoid clutter)
        return interaction.reply({ content: '✅ Draft updated.', flags: MessageFlags.Ephemeral });
      }
    }
  } catch (err) {
    console.error('⚠️ Interaction error:', err);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('⚠️ Something went wrong while handling your request.');
        } else {
          await interaction.reply({ content: '⚠️ Something went wrong while handling your request.', flags: MessageFlags.Ephemeral });
        }
      }
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('🔐 Login successful.'))
  .catch((e) => console.error('🔐 Login failed:', e));
