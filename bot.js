// ------------------ KEEP-ALIVE SERVER ------------------
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is running'));
app.listen(port, () => console.log(`Bot is listening on port ${port}`));


// ------------------ DISCORD + GOOGLE SHEETS SETUP ------------------
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes } = require('discord.js');
const { google } = require('googleapis');
const googleCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);

const clientId = '1437985374398840873';
const guildIds = [
  '1024627335707762688', // your main test server
  '1072289637000814632' // add more if needed
];

const sheets = google.sheets('v4');
const spreadsheetId = '1VrYFm0EquJGNkyqo1OuLUWEUtPmnU1_B0cWZ0t1g7n8';

const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

let caseData = {};
let caseNumber = 1000;

// Event when the bot is ready
client.once('clientReady', async () => {
  console.log(`Bot is online as ${client.user.tag}`);

  // -------- Register Slash Commands (multi-guild) --------
  const commands = [
    new SlashCommandBuilder()
      .setName('mdt')
      .setDescription('Start the MDT process with interactive fields')
      .addStringOption(opt => opt.setName('type').setDescription('Type of report (Arrest Log or Incident Report)').setRequired(true))
      .addStringOption(opt => opt.setName('officer').setDescription('Officer name').setRequired(true))
      .addStringOption(opt => opt.setName('suspect').setDescription('Suspect name').setRequired(true))
      .addStringOption(opt => opt.setName('charge').setDescription('Charge or incident').setRequired(true))
      .addStringOption(opt => opt.setName('location').setDescription('Location of the incident').setRequired(true))
      .addStringOption(opt => opt.setName('evidence').setDescription('Evidence description').setRequired(true))
      .addStringOption(opt => opt.setName('summary').setDescription('Summary or short note for the case').setRequired(false))
      .addAttachmentOption(opt => opt.setName('evidenceimage').setDescription('Evidence image (file upload)')),

    new SlashCommandBuilder()
      .setName('officerstats')
      .setDescription('View officer performance stats')
      .addStringOption(opt => opt.setName('officer').setDescription('Officer name').setRequired(true))
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  for (const id of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, id), { body: commands });
      console.log(`✅ Commands registered for guild ${id}`);
    } catch (err) {
      console.error(`❌ Error registering commands for ${id}:`, err);
    }
  }

  // Optional: Register globally too
  /*
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("🌍 Global commands registered (may take up to 1 hour)");
  */
});


// ------------------ MDT COMMAND HANDLER ------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'mdt') {
    const type = interaction.options.getString('type');
    const officer = interaction.options.getString('officer');
    const suspect = interaction.options.getString('suspect');
    const charge = interaction.options.getString('charge');
    const location = interaction.options.getString('location');
    const evidence = interaction.options.getString('evidence');
    const summary = interaction.options.getString('summary');
    const evidenceImage = interaction.options.getAttachment('evidenceimage');

    await interaction.deferReply();

    const date = new Date().toLocaleDateString();
    const caseNum = type === 'Arrest Log' ? `AL-${date.replace(/\//g, '')}-${caseNumber++}` : `IR-${date.replace(/\//g, '')}-${caseNumber++}`;

    caseData = { caseNum, date, type, officer, suspect, charge, location, evidence, summary, evidenceImage };

    const embed = new EmbedBuilder()
      .setColor(0x0099ff)
      .setTitle(`🚓 ${type} Report`)
      .addFields(
        { name: 'Case Number', value: caseData.caseNum, inline: true },
        { name: 'Date', value: caseData.date, inline: true },
        { name: 'Officer', value: caseData.officer, inline: true },
        { name: 'Suspect', value: caseData.suspect, inline: true },
        { name: 'Charge/Incident', value: caseData.charge, inline: true },
        { name: 'Location', value: caseData.location, inline: true },
        { name: 'Evidence', value: caseData.evidence, inline: false },
        { name: 'Summary', value: caseData.summary || 'No summary provided', inline: false },
      )
      .setImage(caseData.evidenceImage ? caseData.evidenceImage.url : null)
      .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('confirm_mdt').setLabel('✅ Confirm Report').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('cancel_mdt').setLabel('❌ Cancel Report').setStyle(ButtonStyle.Danger)
    );

    await interaction.editReply({ embeds: [embed], components: [buttons] });
  }

  if (commandName === 'officerstats') {
    const officerName = interaction.options.getString('officer');

    const authClient = await auth.getClient();
    const arrestReq = { spreadsheetId, range: 'Arrest Log!A2:I', auth: authClient };
    const incidentReq = { spreadsheetId, range: 'Incident Report!A2:I', auth: authClient };

    try {
      const [arrestRes, incidentRes] = await Promise.all([
        sheets.spreadsheets.values.get(arrestReq),
        sheets.spreadsheets.values.get(incidentReq)
      ]);

      const arrestRows = arrestRes.data.values || [];
      const incidentRows = incidentRes.data.values || [];

      const arrestCases = arrestRows.filter(r => r[2] === officerName).length;
      const incidentCases = incidentRows.filter(r => r[2] === officerName).length;
      const totalCases = arrestCases + incidentCases;

      const statsEmbed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle(`${officerName}'s Stats`)
        .addFields(
          { name: 'Total Cases', value: `${totalCases}` },
          { name: 'Arrests Made', value: `${arrestCases}` },
          { name: 'Incident Reports', value: `${incidentCases}` }
        );

      await interaction.reply({ embeds: [statsEmbed] });
    } catch (err) {
      console.error('Error fetching officer stats:', err);
      await interaction.reply('❌ There was an error fetching the officer stats.');
    }
  }
});


// ------------------ BUTTON INTERACTIONS ------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

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
      caseData.evidenceImage ? caseData.evidenceImage.url : 'No image provided'
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

      await interaction.update({ content: '✅ **MDT Report logged successfully!**', components: [] });
    } catch (err) {
      console.error('Error logging MDT report:', err);
      await interaction.update({ content: '❌ Error logging MDT report.', components: [] });
    }
  }

  if (interaction.customId === 'cancel_mdt') {
    await interaction.update({ content: '❌ **MDT Report entry canceled.**', components: [] });
  }
});

client.login(process.env.DISCORD_TOKEN);

