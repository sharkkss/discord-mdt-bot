const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { google } = require('googleapis');
const googleCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
const DISCORD_TOKEN = 'MTQzNzk4NTM3NDM5ODg0MDg3Mw.Gz3hDj.AUZzHeeYSmoTa2GETJ4xtq8aIJIh3Tzr6EKvU0';  // Replace with your actual bot token
const clientId = '1437985374398840873';  // Replace with your bot's client ID
const guildId = '1024627335707762688';  // Replace with the server ID where you want to register the command

const sheets = google.sheets('v4');
const spreadsheetId = '1VrYFm0EquJGNkyqo1OuLUWEUtPmnU1_B0cWZ0t1g7n8';  // Replace with your Google Sheets ID

const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Initialize the Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

let caseData = {}; // Store the user input
let caseNumber = 1000; // Starting Case Number

// Event when the bot is ready
client.once('clientReady', () => {
  console.log('Bot is online!');
});

// Register Slash Commands
client.on('ready', () => {
  const data = new SlashCommandBuilder()
    .setName('mdt')
    .setDescription('Start the MDT process with interactive fields')
    .addStringOption(option => option.setName('type').setDescription('Type of report (Arrest Log or Incident Report)').setRequired(true))
    .addStringOption(option => option.setName('officer').setDescription('Officer name').setRequired(true))
    .addStringOption(option => option.setName('suspect').setDescription('Suspect name').setRequired(true))
    .addStringOption(option => option.setName('charge').setDescription('Charge or incident').setRequired(true))
    .addStringOption(option => option.setName('location').setDescription('Location of the incident').setRequired(true))
    .addStringOption(option => option.setName('evidence').setDescription('Evidence description').setRequired(true))
    .addStringOption(option => option.setName('summary').setDescription('Summary or short note for the case').setRequired(false))  // New Summary field
    .addAttachmentOption(option => option.setName('evidenceimage').setDescription('Evidence image (file upload)'));

  client.guilds.cache.get(guildId).commands.create(data);
});

// Handle slash command interaction for MDT report creation
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const type = interaction.options.getString('type');
  const officer = interaction.options.getString('officer');
  const suspect = interaction.options.getString('suspect');
  const charge = interaction.options.getString('charge');
  const location = interaction.options.getString('location');
  const evidence = interaction.options.getString('evidence');
  const summary = interaction.options.getString('summary');  // Get the summary input
  const evidenceImage = interaction.options.getAttachment('evidenceimage');

  if (interaction.commandName === 'mdt') {
    await interaction.deferReply();

    // Generate case number and date
    const date = new Date().toLocaleDateString();
    const caseNum = type === 'Arrest Log' ? `AL-${date.replace(/\//g, '')}-${caseNumber++}` : `IR-${date.replace(/\//g, '')}-${caseNumber++}`;

    // Store the case data including the summary
    caseData = { caseNum, date, type, officer, suspect, charge, location, evidence, summary, evidenceImage };

    // Create a fancy embed with the current report details
    const embed = new EmbedBuilder()
      .setColor(0x0099ff)
      .setTitle(`🚓 **${type} Report** 🚓`)
      .setDescription(`Here are the details of the **${type}** report created.`)
      .addFields(
        { name: '📝 **Case Number**', value: caseData.caseNum, inline: true },
        { name: '📅 **Date**', value: caseData.date, inline: true },
        { name: '👮‍♂️ **Officer**', value: caseData.officer, inline: true },
        { name: '👤 **Suspect**', value: caseData.suspect, inline: true },
        { name: '⚖️ **Charge/Incident**', value: caseData.charge, inline: true },
        { name: '📍 **Location**', value: caseData.location, inline: true },
        { name: '🔎 **Evidence**', value: caseData.evidence, inline: false },
        { name: '📝 **Summary**', value: caseData.summary ? caseData.summary : 'No summary provided', inline: false },
      )
      .setImage(caseData.evidenceImage ? caseData.evidenceImage.url : '')  // Add the image here if it exists
      .setFooter({ text: `MDT Report Generated` })
      .setTimestamp();

    const confirmButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('confirm_mdt').setLabel('✅ Confirm Report').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('cancel_mdt').setLabel('❌ Cancel Report').setStyle(ButtonStyle.Danger)
    );

    // Respond with the embed and buttons
    await interaction.editReply({ embeds: [embed], components: [confirmButton] });
  }
});

// Handle confirmation and cancellation of MDT report
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'confirm_mdt') {
    // Log case to Google Sheets based on the report type (Arrest Log or Incident Report)
    const caseDataArray = [
      caseData.caseNum,
      caseData.date,
      caseData.officer,
      caseData.suspect,
      caseData.charge,
      caseData.location,
      caseData.evidence,
      caseData.summary ? caseData.summary : 'No summary provided',
      caseData.evidenceImage ? caseData.evidenceImage.url : 'No image provided'
    ];

    const range = caseData.type === 'Arrest Log' ? 'Arrest Log!A1' : 'Incident Report!A1';

    try {
      const authClient = await auth.getClient();
      const request = {
        spreadsheetId,
        range: range,  // Select the correct sheet based on the report type
        valueInputOption: 'RAW',
        resource: { values: [caseDataArray] },
        auth: authClient,
      };

      await sheets.spreadsheets.values.append(request);
      await interaction.update({ content: '✅ **MDT Report logged successfully!**', components: [] });
    } catch (err) {
      console.error('Error logging MDT report:', err);
      await interaction.update({ content: '❌ There was an error logging the MDT report.', components: [] });
    }
  }

  if (interaction.customId === 'cancel_mdt') {
    await interaction.update({ content: '❌ **MDT Report entry canceled.**', components: [] });
  }
});

// Officer Stats Command
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === 'officerstats') {
    const officerName = interaction.options.getString('officer'); // Officer name from the command

    // Fetch cases from both "Arrest Log" and "Incident Report"
    const authClient = await auth.getClient();
    const requestArrest = {
      spreadsheetId,
      range: 'Arrest Log!A2:I',  // Assuming data starts from row 2
      auth: authClient,
    };
    const requestIncident = {
      spreadsheetId,
      range: 'Incident Report!A2:I',  // Assuming data starts from row 2
      auth: authClient,
    };

    try {
      // Fetch data for Arrest Log
      const responseArrest = await sheets.spreadsheets.values.get(requestArrest);
      const rowsArrest = responseArrest.data.values;
      let totalCases = 0;
      let arrestCases = 0;
      let incidentCases = 0;

      if (rowsArrest && rowsArrest.length > 0) {
        rowsArrest.forEach(row => {
          if (row[2] && row[2] === officerName) { // Check if the officer matches
            totalCases++;
            arrestCases++; // Now every entry for the officer is counted as an arrest
          }
        });
      }

      // Fetch data for Incident Reports
      const responseIncident = await sheets.spreadsheets.values.get(requestIncident);
      const rowsIncident = responseIncident.data.values;

      if (rowsIncident && rowsIncident.length > 0) {
        rowsIncident.forEach(row => {
          if (row[2] && row[2] === officerName) { // Check if the officer matches
            incidentCases++;
          }
        });
      }

      // Send the response with officer stats
      const statsEmbed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle(`${officerName}'s Stats 📊`)
        .addFields(
          { name: '📚 Total Cases Handled', value: `${totalCases + incidentCases}` },  // Total cases = Arrest + Incident
          { name: '🚔 Arrests Made', value: `${arrestCases}` },
          { name: '📄 Incident Reports', value: `${incidentCases}` },
        );

      await interaction.reply({ embeds: [statsEmbed] });

    } catch (err) {
      console.error('Error fetching officer stats:', err);
      await interaction.reply('❌ There was an error fetching the officer stats.');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);



