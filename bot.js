// ￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣
// 🎉 MDT BOT (Fancy + Emoji Edition)
// ￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣
// ✨ What changed:
// - Richer embeds with emojis, author, footer, and timestamp
// - Crisp ✅ Confirm / ❌ Cancel buttons with emoji labels
// - Pretty console logs with emojis
// - Presence status ("on duty")
// - Manila timezone date + compact case number format
// - Slash command improvements (choices for type)
// - Officer stats with a clean, emoji-forward embed
// - Safer checks for env vars + Google credentials
// - Ephemeral replies to keep channels tidy
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

// 🗂️ Simple in-memory state
let caseData = {};
let caseNumber = 1000; // 🔢 Auto-increment per runtime

// 🧮 Helpers
const tz = 'Asia/Manila';
const nowPH = () => new Date().toLocaleString('en-PH', { timeZone: tz });
const datePH = () => new Date().toLocaleDateString('en-PH', { timeZone: tz });
const pad = (n) => String(n).padStart(2, '0');
const yyyymmddPH = () => {
  const d = new Date();
  const y = d.toLocaleString('en-PH', { timeZone: tz, year: 'numeric' });
  const m = d.toLocaleString('en-PH', { timeZone: tz, month: '2-digit' });
  const da = d.toLocaleString('en-PH', { timeZone: tz, day: '2-digit' });
  return `${y}${m}${da}`;
};

// ------------------ 🚀 BOT READY EVENT ------------------
client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag} | 🕒 ${nowPH()} (PH)`);

  // 🟩 Set rich presence
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
            { name: 'Incident Report', value: 'Incident Report' }
          )
      )
      .addStringOption((opt) =>
        opt.setName('officer').setDescription('Officer name').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('suspect').setDescription('Suspect name').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('charge').setDescription('Charge or incident').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('location').setDescription('Location').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('evidence').setDescription('Evidence details').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('summary').setDescription('Summary or note').setRequired(false)
      )
      .addAttachmentOption((opt) =>
        opt.setName('evidenceimage').setDescription('Evidence image')
      ),

    new SlashCommandBuilder()
      .setName('officerstats')
      .setDescription('📊 View officer stats')
      .addStringOption((opt) =>
        opt.setName('officer').setDescription('Officer name').setRequired(true)
      ),
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

      if (commandName === 'mdt') {
        await interaction.deferReply({ ephemeral: true });

        const type = interaction.options.getString('type');
        const officer = interaction.options.getString('officer');
        const suspect = interaction.options.getString('suspect');
        const charge = interaction.options.getString('charge');
        const location = interaction.options.getString('location');
        const evidence = interaction.options.getString('evidence');
        const summary = interaction.options.getString('summary');
        const evidenceImage = interaction.options.getAttachment('evidenceimage');

        const prettyDate = datePH();
        const compactDate = yyyymmddPH();
        const caseNum =
          type === 'Arrest Log'
            ? `AL-${compactDate}-${caseNumber++}`
            : `IR-${compactDate}-${caseNumber++}`;

        caseData = {
          caseNum,
          date: prettyDate,
          type,
          officer,
          suspect,
          charge,
          location,
          evidence,
          summary,
          evidenceImage,
        };

        const embed = new EmbedBuilder()
          .setColor(0x00a3ff)
          .setTitle(`${type === 'Arrest Log' ? '🚔 Arrest Log' : '📝 Incident Report'} — Review & Confirm`)
          .setAuthor({
            name: `${interaction.user.username} • ${nowPH()} (PH)`,
            iconURL: interaction.user.displayAvatarURL({ forceStatic: false }),
          })
          .addFields(
            { name: '🆔 Case Number', value: `**${caseData.caseNum}**`, inline: true },
            { name: '📅 Date', value: caseData.date, inline: true },
            { name: '👮 Officer', value: caseData.officer, inline: true },
            { name: '🧍 Suspect', value: caseData.suspect, inline: true },
            { name: '⚖️ Charge / Incident', value: caseData.charge, inline: true },
            { name: '📍 Location', value: caseData.location, inline: true },
            { name: '🧾 Evidence', value: caseData.evidence || '—', inline: false },
            { name: '🗒️ Summary', value: caseData.summary || 'No summary provided', inline: false }
          )
          .setImage(caseData.evidenceImage ? caseData.evidenceImage.url : null)
          .setFooter({
            text: '✅ Press Confirm to log to Google Sheets • ❌ Cancel to discard',
          })
          .setTimestamp();

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('confirm_mdt')
            .setLabel('Confirm Report')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('cancel_mdt')
            .setLabel('Cancel')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.editReply({ embeds: [embed], components: [buttons] });
      }

      if (commandName === 'officerstats') {
        await interaction.deferReply({ ephemeral: true });

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
              { name: '📝 Incident Reports', value: `${incidentCases}`, inline: true }
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
      if (interaction.customId === 'confirm_mdt') {
        const caseDataArray = [
          caseData.caseNum,
          caseData.date,
          caseData.officer,
          caseData.suspect,
          caseData.charge,
          caseData.location,
          caseData.evidence,
          caseData.summary || 'No summary provided',
          caseData.evidenceImage ? caseData.evidenceImage.url : 'No image provided',
        ];

        const range = caseData.type === 'Arrest Log' ? 'Arrest Log!A1' : 'Incident Report!A1';

        try {
          const authClient = await auth.getClient();
          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: 'RAW',
            resource: { values: [caseDataArray] },
            auth: authClient,
          });

          await interaction.update({
            content: '✅ **MDT Report logged successfully to Google Sheets!**',
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
        await interaction.update({
          content: '❌ **MDT Report entry canceled.**',
          components: [],
          embeds: [],
        });
      }
    }
  } catch (err) {
    console.error('⚠️ Interaction error:', err);
    if (interaction.isRepliable()) {
      try { await interaction.editReply('⚠️ Something went wrong while handling your request.'); } catch {}
    }
  }
});

client.login(process.env.DISCORD_TOKEN).then(() => console.log('🔐 Login successful.')).catch((e) => console.error('🔐 Login failed:', e));
