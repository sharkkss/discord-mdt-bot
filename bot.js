// ═══════════════════════════════════════════
// 🚓 MDT BOT — Separate Commands (Arrest & Incident)
//  • /arrest - For arrest logs with charges & penalties
//  • /incident - For incident reports with event types & witnesses
//  • Enhanced with event type picker and role-based fields
// ═══════════════════════════════════════════

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (_req, res) => res.send('✅ Bot is running — MDT Ready!'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.listen(port, () => console.log(`🛰️  Keep-alive: listening on port ${port}`));

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
  StringSelectMenuBuilder,
  MessageFlags
} = require('discord.js');
const { google } = require('googleapis');

// Global error handlers
process.on('unhandledRejection', (e) => console.error('🔴 UnhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('🔴 UncaughtException:', e));

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in environment.');
  process.exit(1);
}
if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
  console.error('❌ Missing GOOGLE_SHEETS_CREDENTIALS in environment.');
  process.exit(1);
}

const AUDIT_CHANNEL_ID = process.env.AUDIT_CHANNEL_ID || '';

const googleCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);

// 🔗 Optional GIDs for row link building
const ARREST_GID = process.env.ARREST_GID || '';
const INCIDENT_GID = process.env.INCIDENT_GID || '';

// ⚙️ App + guild config
const clientId = '1437985374398840873';
const guildIds = [
  '1024627335707762688', // test server
  '1072289637000814632', // second server
];

// ✅ Role/Channel Guard
const ALLOWED_ROLES = [/* '123456789012345678' */];
const ALLOWED_CHANNELS = [/* '123456789012345678' */];

// 📄 Sheets API
const sheets = google.sheets('v4');
const spreadsheetId = '1VrYFm0EquJGNkyqo1OuLUWEUtPmnU1_B0cWZ0t1g7n8';
const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// 🤖 Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});
client.on('error', (e) => console.error('🔴 Client error:', e));

// 🗂️ Per-user session drafts
const sessions = new Map(); // key: `${userId}:${guildId}` -> { draft }
const sessionKey = (interaction) => `${interaction.user?.id || 'user'}:${interaction.guildId || 'DM'}`;

// 🧮 Helpers
const tz = 'Asia/Manila';
const nowPH = () => new Date().toLocaleString('en-PH', { timeZone: tz });
const datePH = () => new Date().toLocaleDateString('en-PH', { timeZone: tz });
const dateTimePH = () => new Date().toLocaleString('en-PH', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
const yyyymmddPH = () => {
  const d = new Date();
  const y = d.toLocaleString('en-PH', { timeZone: tz, year: 'numeric' });
  const m = d.toLocaleString('en-PH', { timeZone: tz, month: '2-digit' });
  const da = d.toLocaleString('en-PH', { timeZone: tz, day: '2-digit' });
  return `${y}${m}${da}`;
};
const fmtMoney = (n) => `$${Number(String(n||0).replace(/[,]/g,'')).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

function parseCSVSet(text) {
  return new Set(String(text||'').split(',').map(s=>s.trim()).filter(Boolean));
}
function setToCSV(set) { return Array.from(set).join(', '); }

// 🛡️ Safely acknowledge interaction
async function safeDefer(interaction, ephemeral) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      if (ephemeral) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      else await interaction.deferReply();
    }
    return true;
  } catch (e) {
    if (e?.code === 10062) {
      console.warn('⚠️ Interaction token expired before defer. Skipping.');
      return false;
    }
    throw e;
  }
}

// 🔢 Compute next case number
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

  const maxSeq = seqs.length ? Math.max(...seqs) : 999;
  return maxSeq + 1;
}

// ------------- Penalties + Locations (from Sheets) -------------
async function readPenaltiesFromSheet() {
  const authClient = await auth.getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Penalties!A2:E',
    auth: authClient,
  });
  const rows = res.data.values || [];
  return rows
    .filter(r => (r?.[0] && r?.[1]))
    .map(r => ({
      code: String(r[0]).trim(),
      offense: String(r[1]).trim(),
      description: String(r?.[2]||'').trim(),
      jail: Number(String(r?.[3]||'0').replace(/[,]/g,'')),
      fine: Number(String(r?.[4]||'0').replace(/[,]/g,'')),
    }));
}

function buildPenaltyIndex(list) {
  const byName = new Map();
  const byCode = new Map();
  const byGroup = new Map();
  for (const p of list) {
    if (p.offense) byName.set(p.offense.toLowerCase(), p);
    if (p.code) {
      const codeKey = String(p.code).toLowerCase();
      byCode.set(codeKey, p);
      const group = codeKey.slice(0,1)+'00';
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push(p);
    }
  }
  return { byName, byCode, byGroup };
}

async function readLocationsFromSheet() {
  try {
    const authClient = await auth.getClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Locations!A2:A',
      auth: authClient,
    });
    return (res.data.values || []).map(r => String(r[0]).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// 📋 Event types for incidents
const EVENT_TYPES = [
  '🚗 Traffic Accident',
  '🔫 Assault',
  '🏠 Burglary',
  '🔥 Arson',
  '💊 Drug Activity',
  '👥 Disturbance',
  '🚨 Emergency Call',
  '🏪 Robbery',
  '🚶 Missing Person',
  '⚠️ Suspicious Activity',
  '📞 Welfare Check',
  '🎯 Other',
];

function sumPenalties(index, chargeText) {
  const result = { fine: 0, jail: 0, found: [], unknown: [] };
  const items = [...new Set(String(chargeText||'')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  )];

  for (const raw of items) {
    const key = raw.toLowerCase();
    const p = (/^\d+$/.test(key) ? index.byCode.get(key) : index.byName.get(key));
    if (p) {
      result.fine += Number(p.fine||0);
      result.jail += Number(p.jail||0);
      result.found.push(`${p.offense} (${fmtMoney(p.fine)} | ${p.jail}m)`);
    } else {
      result.unknown.push(raw);
    }
  }
  return result;
}

// ---------------- UI builders ----------------
function buildArrestEmbed(draft, user, penaltyTotals) {
  const embed = new EmbedBuilder()
    .setColor(0xff4444)
    .setTitle(`🚓 Arrest Log — Review & Confirm`)
    .setAuthor({ name: `${user.username} • ${nowPH()} (PH)`, iconURL: user.displayAvatarURL({ forceStatic: false }) })
    .addFields(
      { name: '🆔 Case Number', value: `**${draft.caseNum}**`, inline: true },
      { name: '📅 Date', value: draft.date, inline: true },
      { name: '👮 Officer', value: draft.officer, inline: true },
      { name: '🧑 Suspect', value: draft.suspect, inline: true },
      { name: '⚖️ Charges / Codes', value: draft.charge || '—', inline: false },
      { name: '📍 Location', value: draft.location || '—', inline: true },
      { name: '🧾 Evidence', value: draft.evidence || '—', inline: false },
      { name: '🗒️ Summary', value: draft.summary || 'No summary provided', inline: false },
    )
    .setFooter({ text: '✅ Confirm to log • ✏️ Edit to fix • ❌ Cancel to discard' })
    .setTimestamp();

  if (penaltyTotals) {
    embed.addFields(
      { name: '💸 Total Fine', value: fmtMoney(penaltyTotals.fine), inline: true },
      { name: '⏱️ Jail Time', value: `${penaltyTotals.jail} min`, inline: true },
    );
    if (penaltyTotals.found.length) {
      embed.addFields({ name: '🧮 Breakdown', value: penaltyTotals.found.join(', ').slice(0, 1024) });
    }
    if (penaltyTotals.unknown.length) {
      embed.addFields({ name: '⚠️ Unknown charges', value: penaltyTotals.unknown.join(', ').slice(0, 1024) });
    }
  }

  if (draft.evidenceImage?.url) embed.setImage(draft.evidenceImage.url);
  return embed;
}

function buildIncidentEmbed(draft, user) {
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`📝 Incident Report — Review & Confirm`)
    .setAuthor({ name: `${user.username} • ${nowPH()} (PH)`, iconURL: user.displayAvatarURL({ forceStatic: false }) })
    .addFields(
      { name: '🆔 Case Number', value: `**${draft.caseNum}**`, inline: true },
      { name: '📅 Date & Time', value: draft.dateTime, inline: true },
      { name: '👮 Officer', value: draft.officer, inline: true },
      { name: '📍 Location', value: draft.location || '—', inline: true },
      { name: '🎯 Event Type', value: draft.eventType || '—', inline: true },
      { name: '🗒️ Summary', value: draft.summary || 'No summary provided', inline: false },
    )
    .setFooter({ text: '✅ Confirm to log • ✏️ Edit to fix • ❌ Cancel to discard' })
    .setTimestamp();

  // People involved section
  const people = [];
  if (draft.victim) people.push(`**Victim:** ${draft.victim}`);
  if (draft.suspect) people.push(`**Suspect:** ${draft.suspect}`);
  if (draft.witness) people.push(`**Witness:** ${draft.witness}`);
  
  if (people.length) {
    embed.addFields({ name: '👥 People Involved', value: people.join('\n'), inline: false });
  }

  if (draft.evidenceImage?.url) embed.setImage(draft.evidenceImage.url);
  return embed;
}

function buildArrestButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm_arrest').setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('edit_arrest').setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pick_charges').setLabel('Pick Charges').setEmoji('🧾').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pick_location').setLabel('Pick Location').setEmoji('📍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cancel_mdt').setLabel('Cancel').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
}

function buildIncidentButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm_incident').setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('edit_incident').setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pick_event_type').setLabel('Event Type').setEmoji('🎯').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pick_location').setLabel('Pick Location').setEmoji('📍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cancel_mdt').setLabel('Cancel').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
}

// Build charge picker menus with pagination
function buildChargeMenus(pIndex, page = 0) {
  const groupsAll = Array.from(pIndex.byGroup.keys()).sort();
  const pageSize = 4;
  const totalPages = Math.max(1, Math.ceil(groupsAll.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);

  const start = safePage * pageSize;
  const sliceGroups = groupsAll.slice(start, start + pageSize);

  const rows = [];
  for (const g of sliceGroups) {
    const items = (pIndex.byGroup.get(g) || []).map(p => ({
      label: `${p.code} • ${p.offense}`.slice(0, 100),
      value: p.offense,
      description: (p.description || '').slice(0, 100),
    }));
    if (!items.length) continue;

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`sel_charge_${g}`)
      .setPlaceholder(`${g}s • Select charges`)
      .setMinValues(0)
      .setMaxValues(Math.min(items.length, 25))
      .addOptions(items);

    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`charges_prev_${safePage}`)
      .setLabel('Prev').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(`charges_next_${safePage}`)
      .setLabel('Next').setEmoji('➡️').setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId('charges_close')
      .setLabel('Close').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );

  return { rows: [...rows, nav], page: safePage, totalPages };
}

function buildLocationMenu(locations) {
  const opts = locations.slice(0,25).map(l => ({ label: l, value: l }));
  if (!opts.length) return [];
  const menu = new StringSelectMenuBuilder()
    .setCustomId('sel_location')
    .setPlaceholder('Select location')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(opts);
  return [new ActionRowBuilder().addComponents(menu)];
}

function buildEventTypeMenu() {
  const opts = EVENT_TYPES.map(e => ({ label: e, value: e }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId('sel_event_type')
    .setPlaceholder('Select event type')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(opts);
  return [new ActionRowBuilder().addComponents(menu)];
}

async function logAudit(guild, content, embed) {
  if (!AUDIT_CHANNEL_ID) return;
  try {
    const ch = guild.channels.cache.get(AUDIT_CHANNEL_ID) || await guild.channels.fetch(AUDIT_CHANNEL_ID);
    if (ch) await ch.send({ content, embeds: embed ? [embed] : [] });
  } catch (e) {
    console.error('⚠️ Audit log send failed:', e.message);
  }
}

// ------------------ 🚀 BOT READY EVENT ------------------
client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag} | 🕐 ${nowPH()} (PH)`);
  client.user.setPresence({
    activities: [{ name: '🚓 MDT on duty | /arrest /incident', type: 0 }],
    status: 'online',
  });

  // 🛠️ Slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('arrest')
      .setDescription('🚓 Create an arrest log entry')
      .addStringOption((opt) => opt.setName('officer').setDescription('Officer name').setRequired(true))
      .addStringOption((opt) => opt.setName('suspect').setDescription('Suspect name').setRequired(true))
      .addStringOption((opt) => opt.setName('charge').setDescription('Charge(s) or code(s), comma-separated').setRequired(true))
      .addStringOption((opt) => opt.setName('location').setDescription('Location').setRequired(true))
      .addStringOption((opt) => opt.setName('evidence').setDescription('Evidence details').setRequired(true))
      .addStringOption((opt) => opt.setName('summary').setDescription('Summary or note').setRequired(false))
      .addAttachmentOption((opt) => opt.setName('evidenceimage').setDescription('Evidence image'))
      .addBooleanOption((opt) => opt.setName('private').setDescription('Make the initial preview private (ephemeral)?'))
      .toJSON(),

    new SlashCommandBuilder()
      .setName('incident')
      .setDescription('📝 Create an incident report')
      .addStringOption((opt) => opt.setName('officer').setDescription('Officer name').setRequired(true))
      .addStringOption((opt) => opt.setName('location').setDescription('Location').setRequired(true))
      .addStringOption((opt) => opt.setName('eventtype').setDescription('Type of event (or use picker)').setRequired(false))
      .addStringOption((opt) => opt.setName('summary').setDescription('Short summary of what happened').setRequired(true))
      .addStringOption((opt) => opt.setName('victim').setDescription('Victim name(s)').setRequired(false))
      .addStringOption((opt) => opt.setName('suspect').setDescription('Suspect name(s)').setRequired(false))
      .addStringOption((opt) => opt.setName('witness').setDescription('Witness name(s)').setRequired(false))
      .addAttachmentOption((opt) => opt.setName('evidenceimage').setDescription('Evidence image'))
      .addBooleanOption((opt) => opt.setName('private').setDescription('Make the initial preview private (ephemeral)?'))
      .toJSON(),

    new SlashCommandBuilder()
      .setName('officerstats')
      .setDescription('📊 View officer stats')
      .addStringOption((opt) => opt.setName('officer').setDescription('Officer name').setRequired(true))
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  console.log('📝 Registering commands...');
  for (const id of guildIds) {
    try {
      const result = await rest.put(Routes.applicationGuildCommands(clientId, id), { body: commands });
      console.log(`✅ Guild ${id}: Registered ${result.length} commands`);
      result.forEach(cmd => console.log(`   /${cmd.name} - ${cmd.description}`));
    } catch (err) {
      console.error(`❌ Failed to register commands for guild ${id}:`, err.message);
      if (err.rawError) console.error('   Raw error:', JSON.stringify(err.rawError, null, 2));
    }
  }
});

// ------------------ 🧩 INTERACTION HANDLER ------------------
client.on('interactionCreate', async (interaction) => {
  try {
    // ---------- ⌨️ SLASH COMMANDS ----------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      // Role/Channel guard
      if (ALLOWED_CHANNELS.length && !ALLOWED_CHANNELS.includes(interaction.channelId)) {
        const hint = ALLOWED_CHANNELS.map(id => `<#${id}>`).join(', ');
        return interaction.reply({ content: `🔒 Please use this in: ${hint}`, flags: MessageFlags.Ephemeral });
      }
      if (ALLOWED_ROLES.length && !interaction.member?.roles?.cache?.some(r => ALLOWED_ROLES.includes(r.id))) {
        return interaction.reply({ content: `🔒 You don't have permission to use this command.`, flags: MessageFlags.Ephemeral });
      }

      if (commandName === 'arrest') {
        const makePrivate = interaction.options.getBoolean('private') ?? false;
        const acked = await safeDefer(interaction, makePrivate);
        if (!acked) return;

        const officer = interaction.options.getString('officer');
        const suspect = interaction.options.getString('suspect');
        const charge = interaction.options.getString('charge');
        const location = interaction.options.getString('location');
        const evidence = interaction.options.getString('evidence');
        const summary = interaction.options.getString('summary');
        const evidenceImage = interaction.options.getAttachment('evidenceimage');

        const day = yyyymmddPH();
        const nextSeq = await getNextCaseSeq('Arrest Log');
        const caseNum = `AL-${day}-${nextSeq}`;

        const draft = {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          type: 'Arrest Log',
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
          threadId: null,
        };
        sessions.set(sessionKey(interaction), draft);

        const penalties = await readPenaltiesFromSheet();
        const pIndex = buildPenaltyIndex(penalties);
        const totals = sumPenalties(pIndex, draft.charge);

        const embed = buildArrestEmbed(draft, interaction.user, totals);
        const buttons = buildArrestButtons();

        const thread = await interaction.channel.threads.create({ name: draft.caseNum, autoArchiveDuration: 1440 });
        draft.threadId = thread.id;
        sessions.set(sessionKey(interaction), draft);

        await interaction.editReply({ content: `🧵 Moved preview to thread: <#${thread.id}>` });

        const msg = await thread.send({ embeds: [embed], components: [buttons] });
        draft.messageId = msg.id;
        sessions.set(sessionKey(interaction), draft);

        await logAudit(interaction.guild, `🟡 Arrest draft started: **${draft.caseNum}** by <@${draft.userId}>`, embed);
      }

      if (commandName === 'incident') {
        const makePrivate = interaction.options.getBoolean('private') ?? false;
        const acked = await safeDefer(interaction, makePrivate);
        if (!acked) return;

        const officer = interaction.options.getString('officer');
        const location = interaction.options.getString('location');
        const eventType = interaction.options.getString('eventtype');
        const summary = interaction.options.getString('summary');
        const victim = interaction.options.getString('victim');
        const suspect = interaction.options.getString('suspect');
        const witness = interaction.options.getString('witness');
        const evidenceImage = interaction.options.getAttachment('evidenceimage');

        const day = yyyymmddPH();
        const nextSeq = await getNextCaseSeq('Incident Report');
        const caseNum = `IR-${day}-${nextSeq}`;

        const draft = {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          type: 'Incident Report',
          caseNum,
          seq: nextSeq,
          dateTime: dateTimePH(),
          officer: officer?.trim(),
          location: location?.trim(),
          eventType: eventType?.trim() || '',
          summary: summary?.trim(),
          victim: victim?.trim() || '',
          suspect: suspect?.trim() || '',
          witness: witness?.trim() || '',
          evidenceImage,
          messageId: null,
          threadId: null,
        };
        sessions.set(sessionKey(interaction), draft);

        const embed = buildIncidentEmbed(draft, interaction.user);
        const buttons = buildIncidentButtons();

        const thread = await interaction.channel.threads.create({ name: draft.caseNum, autoArchiveDuration: 1440 });
        draft.threadId = thread.id;
        sessions.set(sessionKey(interaction), draft);

        await interaction.editReply({ content: `🧵 Moved preview to thread: <#${thread.id}>` });

        const msg = await thread.send({ embeds: [embed], components: [buttons] });
        draft.messageId = msg.id;
        sessions.set(sessionKey(interaction), draft);

        await logAudit(interaction.guild, `🟡 Incident draft started: **${draft.caseNum}** by <@${draft.userId}>`, embed);
      }

      if (commandName === 'officerstats') {
        const acked = await safeDefer(interaction, false);
        if (!acked) return;

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
          const incidentCases = incidentRows.filter((r) => (r?.[6] || '').toLowerCase() === officerName.toLowerCase()).length;
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

    // ---------- 📘 BUTTONS ----------
    else if (interaction.isButton()) {
      const key = sessionKey(interaction);
      const draft = sessions.get(key);

      if (!interaction.customId.startsWith('charges_')) {
        if (!draft) {
          return interaction.reply({ content: '⚠️ No active MDT draft. Use **/arrest** or **/incident**.', flags: MessageFlags.Ephemeral });
        }
        if (interaction.user.id !== draft.userId) {
          return interaction.reply({ content: '🚫 This draft belongs to another user.', flags: MessageFlags.Ephemeral });
        }
      }

      if (interaction.customId === 'pick_charges') {
        const penalties = await readPenaltiesFromSheet();
        const pIndex = buildPenaltyIndex(penalties);
        draft.penaltyIndex = pIndex;
        sessions.set(key, draft);

        const { rows } = buildChargeMenus(pIndex, 0);
        return interaction.reply({
          content: '🧾 Pick charges by group (use Prev/Next to switch pages):',
          components: rows,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.customId === 'pick_location') {
        const locs = await readLocationsFromSheet();
        const rows = buildLocationMenu(locs);
        if (!rows.length) return interaction.reply({ content: '⚠️ No `Locations` tab or it is empty.', flags: MessageFlags.Ephemeral });
        return interaction.reply({ content: '📍 Pick a location:', components: rows, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'pick_event_type') {
        const rows = buildEventTypeMenu();
        return interaction.reply({ content: '🎯 Pick an event type:', components: rows, flags: MessageFlags.Ephemeral });
      }

      // Pagination nav buttons for charge menus
      if (interaction.customId.startsWith('charges_prev_') || interaction.customId.startsWith('charges_next_')) {
        const parts = interaction.customId.split('_');
        const dir = parts[1];
        let page = Number(parts[2] || 0);
        page = dir === 'next' ? page + 1 : page - 1;

        const penalties = await readPenaltiesFromSheet();
        const pIndex = buildPenaltyIndex(penalties);
        const { rows } = buildChargeMenus(pIndex, page);

        return interaction.update({
          content: '🧾 Pick charges by group (use Prev/Next to switch pages):',
          components: rows,
        });
      }
      if (interaction.customId === 'charges_close') {
        return interaction.update({ content: '✅ Charge picker closed.', components: [] });
      }

      if (interaction.customId === 'confirm_arrest') {
        const key = sessionKey(interaction);
        const draft = sessions.get(key);
        if (!draft) {
          return interaction.reply({ content: '⚠️ Draft expired. Use **/arrest** again.', flags: MessageFlags.Ephemeral });
        }

        // Recompute next sequence to avoid race conditions
        const nextSeq = await getNextCaseSeq(draft.type);
        const day = yyyymmddPH();
        draft.seq = nextSeq;
        draft.caseNum = `AL-${day}-${nextSeq}`;

        const row = [
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
        const range = 'Arrest Log!A1';

        try {
          const authClient = await auth.getClient();
          const resp = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: 'RAW',
            resource: { values: [row] },
            auth: authClient,
          });

          let rowLink = '';
          try {
            const updatedRange = resp?.data?.updates?.updatedRange || resp?.updates?.updatedRange || '';
            const rowNumMatch = updatedRange.match(/!.*?(\d+):/);
            const rowNum = rowNumMatch ? parseInt(rowNumMatch[1], 10) : null;
            if (rowNum && ARREST_GID) {
              rowLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${ARREST_GID}&range=A${rowNum}:I${rowNum}`;
            }
          } catch {}

          const penalties = await readPenaltiesFromSheet();
          const pIndex = buildPenaltyIndex(penalties);
          const totals = sumPenalties(pIndex, draft.charge);

          const finalEmbed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle(`✅ ${draft.caseNum} — Arrest Log`)
            .addFields(
              { name: '👮 Officer', value: draft.officer || '—', inline: true },
              { name: '🧑 Suspect', value: draft.suspect || '—', inline: true },
              { name: '📅 Date', value: draft.date || '—', inline: true },
              { name: '📍 Location', value: draft.location || '—', inline: true },
              { name: '⚖️ Charges', value: draft.charge || '—', inline: false },
              { name: '💸 Total Fine', value: fmtMoney(totals.fine), inline: true },
              { name: '⏱️ Jail Time', value: `${totals.jail} min`, inline: true },
            )
            .setFooter({ text: 'Logged to Google Sheets' })
            .setTimestamp();
          if (totals.found.length) {
            finalEmbed.addFields({ name: '🧮 Breakdown', value: totals.found.join('\n').slice(0, 1024) });
          }
          if (draft.summary) finalEmbed.addFields({ name: '🗒️ Summary', value: String(draft.summary).slice(0, 1024) });
          if (draft.evidence) finalEmbed.addFields({ name: '🧾 Evidence', value: String(draft.evidence).slice(0, 1024) });
          if (draft.evidenceImage?.url) finalEmbed.setImage(draft.evidenceImage.url);
          if (rowLink) finalEmbed.setURL(rowLink);

          await interaction.update({ embeds: [finalEmbed], components: [] });

          if (rowLink) {
            await interaction.followUp({ content: `🔗 **Open row:** ${rowLink}` });
          }

          await logAudit(interaction.guild, `🟢 Arrest confirmed: **${draft.caseNum}** by <@${interaction.user.id}>`, finalEmbed);
          sessions.delete(key);
        } catch (err) {
          console.error('🚨 Error logging arrest:', err);
          try {
            await interaction.update({ content: '❌ Error logging arrest. Check Google credentials & spreadsheet ID.', components: [], embeds: [] });
          } catch {}
          await logAudit(interaction.guild, `🔴 Arrest confirm failed for **${draft.caseNum}** (${err.message})`, null);
        }
      }

      if (interaction.customId === 'confirm_incident') {
        const key = sessionKey(interaction);
        const draft = sessions.get(key);
        if (!draft) {
          return interaction.reply({ content: '⚠️ Draft expired. Use **/incident** again.', flags: MessageFlags.Ephemeral });
        }

        // Recompute next sequence to avoid race conditions
        const nextSeq = await getNextCaseSeq(draft.type);
        const day = yyyymmddPH();
        draft.seq = nextSeq;
        draft.caseNum = `IR-${day}-${nextSeq}`;

        const row = [
          draft.caseNum,
          draft.dateTime,
          draft.location,
          draft.eventType || 'Not specified',
          draft.summary || 'No summary provided',
          draft.victim || 'None',
          draft.suspect || 'None',
          draft.witness || 'None',
          draft.officer,
          draft.evidenceImage ? draft.evidenceImage.url : 'No image provided',
        ];
        const range = 'Incident Report!A1';

        try {
          const authClient = await auth.getClient();
          const resp = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: 'RAW',
            resource: { values: [row] },
            auth: authClient,
          });

          let rowLink = '';
          try {
            const updatedRange = resp?.data?.updates?.updatedRange || resp?.updates?.updatedRange || '';
            const rowNumMatch = updatedRange.match(/!.*?(\d+):/);
            const rowNum = rowNumMatch ? parseInt(rowNumMatch[1], 10) : null;
            if (rowNum && INCIDENT_GID) {
              rowLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${INCIDENT_GID}&range=A${rowNum}:J${rowNum}`;
            }
          } catch {}

          const finalEmbed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle(`✅ ${draft.caseNum} — Incident Report`)
            .addFields(
              { name: '👮 Officer', value: draft.officer || '—', inline: true },
              { name: '📅 Date & Time', value: draft.dateTime || '—', inline: true },
              { name: '📍 Location', value: draft.location || '—', inline: true },
              { name: '🎯 Event Type', value: draft.eventType || 'Not specified', inline: true },
              { name: '🗒️ Summary', value: (draft.summary || 'No summary provided').slice(0, 1024), inline: false },
            )
            .setFooter({ text: 'Logged to Google Sheets' })
            .setTimestamp();

          const people = [];
          if (draft.victim) people.push(`**Victim:** ${draft.victim}`);
          if (draft.suspect) people.push(`**Suspect:** ${draft.suspect}`);
          if (draft.witness) people.push(`**Witness:** ${draft.witness}`);
          
          if (people.length) {
            finalEmbed.addFields({ name: '👥 People Involved', value: people.join('\n') });
          }

          if (draft.evidenceImage?.url) finalEmbed.setImage(draft.evidenceImage.url);
          if (rowLink) finalEmbed.setURL(rowLink);

          await interaction.update({ embeds: [finalEmbed], components: [] });

          if (rowLink) {
            await interaction.followUp({ content: `🔗 **Open row:** ${rowLink}` });
          }

          await logAudit(interaction.guild, `🟢 Incident confirmed: **${draft.caseNum}** by <@${interaction.user.id}>`, finalEmbed);
          sessions.delete(key);
        } catch (err) {
          console.error('🚨 Error logging incident:', err);
          try {
            await interaction.update({ content: '❌ Error logging incident. Check Google credentials & spreadsheet ID.', components: [], embeds: [] });
          } catch {}
          await logAudit(interaction.guild, `🔴 Incident confirm failed for **${draft.caseNum}** (${err.message})`, null);
        }
      }

      if (interaction.customId === 'cancel_mdt') {
        sessions.delete(key);
        await interaction.update({ content: '❌ **MDT Report entry canceled.**', components: [], embeds: [] });
        await logAudit(interaction.guild, `🟠 Canceled draft for **${draft.caseNum}** by <@${interaction.user.id}>`, null);
      }

      if (interaction.customId === 'edit_arrest') {
        draft.messageId = interaction.message?.id || draft.messageId;
        sessions.set(key, draft);

        const modal = new ModalBuilder().setCustomId('arrest_modal').setTitle('✏️ Edit Arrest Draft');

        const mkShort = (id, label, value, required = true) =>
          new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setValue((value || '').slice(0, 100));
        const mkLong = (id, label, value, required = false) =>
          new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(required).setValue((value || '').slice(0, 1024));

        modal.addComponents(
          new ActionRowBuilder().addComponents(mkShort('officer', 'Officer', draft.officer)),
          new ActionRowBuilder().addComponents(mkShort('suspect', 'Suspect', draft.suspect)),
          new ActionRowBuilder().addComponents(mkShort('charge', 'Charge / Codes (comma-separated)', draft.charge)),
          new ActionRowBuilder().addComponents(mkShort('location', 'Location', draft.location)),
          new ActionRowBuilder().addComponents(mkLong('summary', 'Summary (optional)', draft.summary, false)),
        );

        await interaction.showModal(modal);
      }

      if (interaction.customId === 'edit_incident') {
        draft.messageId = interaction.message?.id || draft.messageId;
        sessions.set(key, draft);

        const modal = new ModalBuilder().setCustomId('incident_modal').setTitle('✏️ Edit Incident Draft');

        const mkShort = (id, label, value, required = true) =>
          new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setValue((value || '').slice(0, 100));
        const mkLong = (id, label, value, required = false) =>
          new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(required).setValue((value || '').slice(0, 1024));

        modal.addComponents(
          new ActionRowBuilder().addComponents(mkShort('officer', 'Officer', draft.officer)),
          new ActionRowBuilder().addComponents(mkShort('location', 'Location', draft.location)),
          new ActionRowBuilder().addComponents(mkLong('summary', 'Summary', draft.summary, true)),
          new ActionRowBuilder().addComponents(mkShort('victim', 'Victim (optional)', draft.victim, false)),
          new ActionRowBuilder().addComponents(mkShort('suspect', 'Suspect (optional)', draft.suspect, false)),
        );

        await interaction.showModal(modal);
      }
    }

    // ---------- 🧾 SELECT MENUS ----------
    else if (interaction.isStringSelectMenu()) {
      const key = sessionKey(interaction);
      const draft = sessions.get(key);
      if (!draft) return interaction.reply({ content: '⚠️ No active MDT draft. Use **/arrest** or **/incident**.', flags: MessageFlags.Ephemeral });
      if (interaction.user.id !== draft.userId) return interaction.reply({ content: '🚫 This draft belongs to another user.', flags: MessageFlags.Ephemeral });

      if (interaction.customId.startsWith('sel_charge_')) {
        const current = parseCSVSet(draft.charge);
        for (const v of interaction.values) current.add(v);
        draft.charge = setToCSV(current);
        sessions.set(key, draft);

        const penalties = await readPenaltiesFromSheet();
        const pIndex = buildPenaltyIndex(penalties);
        const totals = sumPenalties(pIndex, draft.charge);
        const embed = buildArrestEmbed(draft, interaction.user, totals);
        const buttons = buildArrestButtons();
        try {
          if (draft.messageId && interaction.channel) {
            await interaction.channel.messages.edit(draft.messageId, { embeds: [embed], components: [buttons] });
          }
        } catch (e) { console.error('⚠️ Failed to edit preview message:', e); }

        return interaction.update({ content: `🧾 Added ${interaction.values.length} charge(s). Current: ${draft.charge}` });
      }

      if (interaction.customId === 'sel_location') {
        draft.location = interaction.values[0];
        sessions.set(key, draft);

        let embed, buttons;
        if (draft.type === 'Arrest Log') {
          const penalties = await readPenaltiesFromSheet();
          const pIndex = buildPenaltyIndex(penalties);
          const totals = sumPenalties(pIndex, draft.charge);
          embed = buildArrestEmbed(draft, interaction.user, totals);
          buttons = buildArrestButtons();
        } else {
          embed = buildIncidentEmbed(draft, interaction.user);
          buttons = buildIncidentButtons();
        }

        try {
          if (draft.messageId && interaction.channel) {
            await interaction.channel.messages.edit(draft.messageId, { embeds: [embed], components: [buttons] });
          }
        } catch (e) { console.error('⚠️ Failed to edit preview message:', e); }

        return interaction.update({ content: `📍 Location set to **${draft.location}**.` });
      }

      if (interaction.customId === 'sel_event_type') {
        draft.eventType = interaction.values[0];
        sessions.set(key, draft);

        const embed = buildIncidentEmbed(draft, interaction.user);
        const buttons = buildIncidentButtons();

        try {
          if (draft.messageId && interaction.channel) {
            await interaction.channel.messages.edit(draft.messageId, { embeds: [embed], components: [buttons] });
          }
        } catch (e) { console.error('⚠️ Failed to edit preview message:', e); }

        return interaction.update({ content: `🎯 Event type set to **${draft.eventType}**.` });
      }
    }

    // ---------- 📝 MODAL SUBMISSIONS ----------
    else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'arrest_modal') {
        const key = sessionKey(interaction);
        const draft = sessions.get(key);
        if (!draft) return interaction.reply({ content: '⚠️ Draft not found. Please run **/arrest** again.', flags: MessageFlags.Ephemeral });
        if (interaction.user.id !== draft.userId) return interaction.reply({ content: '🚫 This draft belongs to another user.', flags: MessageFlags.Ephemeral });

        draft.officer = interaction.fields.getTextInputValue('officer').trim();
        draft.suspect = interaction.fields.getTextInputValue('suspect').trim();
        draft.charge = interaction.fields.getTextInputValue('charge').trim();
        draft.location = interaction.fields.getTextInputValue('location').trim();
        draft.summary = interaction.fields.getTextInputValue('summary').trim();
        sessions.set(key, draft);

        const penalties = await readPenaltiesFromSheet();
        const pIndex = buildPenaltyIndex(penalties);
        const totals = sumPenalties(pIndex, draft.charge);
        const embed = buildArrestEmbed(draft, interaction.user, totals);
        const buttons = buildArrestButtons();
        try {
          if (draft.messageId && interaction.channel) {
            await interaction.channel.messages.edit(draft.messageId, { embeds: [embed], components: [buttons] });
          }
        } catch (e) { console.error('⚠️ Failed to edit preview message:', e); }

        await logAudit(interaction.guild, `✏️ Edited arrest draft **${draft.caseNum}** by <@${interaction.user.id}>`, embed);
        return interaction.reply({ content: '✅ Draft updated.', flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'incident_modal') {
        const key = sessionKey(interaction);
        const draft = sessions.get(key);
        if (!draft) return interaction.reply({ content: '⚠️ Draft not found. Please run **/incident** again.', flags: MessageFlags.Ephemeral });
        if (interaction.user.id !== draft.userId) return interaction.reply({ content: '🚫 This draft belongs to another user.', flags: MessageFlags.Ephemeral });

        draft.officer = interaction.fields.getTextInputValue('officer').trim();
        draft.location = interaction.fields.getTextInputValue('location').trim();
        draft.summary = interaction.fields.getTextInputValue('summary').trim();
        draft.victim = interaction.fields.getTextInputValue('victim').trim();
        draft.suspect = interaction.fields.getTextInputValue('suspect').trim();
        sessions.set(key, draft);

        const embed = buildIncidentEmbed(draft, interaction.user);
        const buttons = buildIncidentButtons();
        try {
          if (draft.messageId && interaction.channel) {
            await interaction.channel.messages.edit(draft.messageId, { embeds: [embed], components: [buttons] });
          }
        } catch (e) { console.error('⚠️ Failed to edit preview message:', e); }

        await logAudit(interaction.guild, `✏️ Edited incident draft **${draft.caseNum}** by <@${interaction.user.id}>`, embed);
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
  .then(() => console.log('🔑 Login successful.'))
  .catch((e) => console.error('🔑 Login failed:', e));
