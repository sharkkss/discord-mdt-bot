// ￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣
// 🚓 MDT BOT — Round 2
//  • Penalties totals (fine + jail) from Penalties tab (A:E)
//  • Quick-pick menus for Charges (by code group) and Location
//  • Audit log channel mirror (AUDIT_CHANNEL_ID)
//  • Keeps: private/public preview, case thread, row link
// ￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣

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

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in environment.');
  process.exit(1);
}
if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
  console.error('❌ Missing GOOGLE_SHEETS_CREDENTIALS in environment.');
  process.exit(1);
}

const AUDIT_CHANNEL_ID = process.env.AUDIT_CHANNEL_ID || ''; // mirror actions here

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

// ✅ Role/Channel Guard — fill with your real IDs (or leave empty to allow all)
const ALLOWED_ROLES = [/* '123456789012345678' */];
const ALLOWED_CHANNELS = [/* '123456789012345678' */];

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
const fmtMoney = (n) => `$${Number(String(n||0).replace(/[,]/g,'')).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

function parseCSVSet(text) {
  return new Set(String(text||'').split(',').map(s=>s.trim()).filter(Boolean));
}
function setToCSV(set) { return Array.from(set).join(', '); }

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

// ------------- Penalties + Locations (from Sheets) -------------
async function readPenaltiesFromSheet() {
  const authClient = await auth.getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Penalties!A2:E', // CODE | OFFENSE | DESCRIPTION | JAIL | FINE
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
  const byGroup = new Map(); // "100","200",...
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
    return []; // if Locations tab absent, we simply won't show the pick menu
  }
}
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
function buildMdtEmbed(draft, user, penaltyTotals) {
  const embed = new EmbedBuilder()
    .setColor(0x00a3ff)
    .setTitle(`${draft.type === 'Arrest Log' ? '🚔 Arrest Log' : '📝 Incident Report'} — Review & Confirm`)
    .setAuthor({ name: `${user.username} • ${nowPH()} (PH)`, iconURL: user.displayAvatarURL({ forceStatic: false }) })
    .addFields(
      { name: '🆔 Case Number', value: `**${draft.caseNum}**`, inline: true },
      { name: '📅 Date', value: draft.date, inline: true },
      { name: '👮 Officer', value: draft.officer, inline: true },
      { name: '🧍 Suspect', value: draft.suspect, inline: true },
      { name: '⚖️ Charges / Codes', value: draft.charge || '—', inline: false },
      { name: '📍 Location', value: draft.location || '—', inline: true },
      { name: '🧾 Evidence', value: draft.evidence || '—', inline: false },
      { name: '🗒️ Summary', value: draft.summary || 'No summary provided', inline: false },
    )
    .setFooter({ text: '✅ Confirm to log to Google Sheets • ✏️ Edit to fix • ❌ Cancel to discard' })
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

function buildMdtButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm_mdt').setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('edit_mdt').setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pick_charges').setLabel('Pick Charges').setEmoji('🧾').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pick_location').setLabel('Pick Location').setEmoji('📍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cancel_mdt').setLabel('Cancel').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
}

function buildChargeMenus(pIndex) {
  const rows = [];
  const groups = ['100','200','300','400','500','600'];
  for (const g of groups) {
    const items = (pIndex.byGroup.get(g) || []).map(p => ({
      label: `${p.code} • ${p.offense}`.slice(0, 100),
      value: p.offense, // we store name; totals accept name or code anyway
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
  return rows;
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
  console.log(`✅ Bot online as ${client.user.tag} | 🕒 ${nowPH()} (PH)`);
  client.user.setPresence({
    activities: [{ name: '🚓 MDT on duty | /mdt', type: 0 }],
    status: 'online',
  });

  // 🛠️ Slash commands (added boolean option `private`)
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
      .addStringOption((opt) => opt.setName('charge').setDescription('Charge(s) or code(s), comma-separated').setRequired(true))
      .addStringOption((opt) => opt.setName('location').setDescription('Location').setRequired(true))
      .addStringOption((opt) => opt.setName('evidence').setDescription('Evidence details').setRequired(true))
      .addStringOption((opt) => opt.setName('summary').setDescription('Summary or note').setRequired(false))
      .addAttachmentOption((opt) => opt.setName('evidenceimage').setDescription('Evidence image'))
      .addBooleanOption((opt) => opt.setName('private').setDescription('Make the initial preview private (ephemeral)?')),

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
        // Public/Private toggle
        const makePrivate = interaction.options.getBoolean('private') ?? false;
        if (makePrivate) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        else await interaction.deferReply();

        const type = interaction.options.getString('type');
        const officer = interaction.options.getString('officer');
        const suspect = interaction.options.getString('suspect');
        const charge = interaction.options.getString('charge');
        const location = interaction.options.getString('location');
        const evidence = interaction.options.getString('evidence');
        const summary = interaction.options.getString('summary');
        const evidenceImage = interaction.options.getAttachment('evidenceimage');

        // Case number
        const day = yyyymmddPH();
        const prefix = type === 'Arrest Log' ? 'AL' : 'IR';
        const nextSeq = await getNextCaseSeq(type);
        const caseNum = `${prefix}-${day}-${nextSeq}`;

        const draft = {
          userId: interaction.user.id,
          guildId: interaction.guildId,
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
          threadId: null,
        };
        sessions.set(sessionKey(interaction), draft);

        // Penalties
        const penalties = await readPenaltiesFromSheet();
        const pIndex = buildPenaltyIndex(penalties);
        const totals = sumPenalties(pIndex, draft.charge);

        const embed = buildMdtEmbed(draft, interaction.user, totals);
        const buttons = buildMdtButtons();

        // Thread
        const thread = await interaction.channel.threads.create({ name: draft.caseNum, autoArchiveDuration: 1440 });
        draft.threadId = thread.id;
        sessions.set(sessionKey(interaction), draft);

        await interaction.editReply({ content: `🧵 Moved preview to thread: <#${thread.id}>` });

        const msg = await thread.send({ embeds: [embed], components: [buttons] });
        draft.messageId = msg.id;
        sessions.set(sessionKey(interaction), draft);

        // Audit
        await logAudit(interaction.guild, `🟡 Draft started: **${draft.caseNum}** by <@${draft.userId}>`, embed);
      }

      if (commandName === 'officerstats') {
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

    // ---------- 🔘 BUTTONS ----------
    else if (interaction.isButton()) {
      const key = sessionKey(interaction);
      const draft = sessions.get(key);
      if (!draft) return interaction.reply({ content: '⚠️ No active MDT draft. Use **/mdt**.', flags: MessageFlags.Ephemeral });
      if (interaction.user.id !== draft.userId) return interaction.reply({ content: '🚫 This draft belongs to another user.', flags: MessageFlags.Ephemeral });

      if (interaction.customId === 'pick_charges') {
        const penalties = await readPenaltiesFromSheet();
        const pIndex = buildPenaltyIndex(penalties);
        draft.penaltyIndex = pIndex;
        sessions.set(key, draft);

        const rows = buildChargeMenus(pIndex);
        if (!rows.length) return interaction.reply({ content: '⚠️ No penalties configured.', flags: MessageFlags.Ephemeral });
        return interaction.reply({ content: '🧾 Pick charges by group (you can open each menu):', components: rows, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'pick_location') {
        const locs = await readLocationsFromSheet();
        const rows = buildLocationMenu(locs);
        if (!rows.length) return interaction.reply({ content: '⚠️ No `Locations` tab or it is empty.', flags: MessageFlags.Ephemeral });
        return interaction.reply({ content: '📍 Pick a location:', components: rows, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'confirm_mdt') {
        // Recompute next sequence to avoid race conditions
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
          const resp = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: 'RAW',
            resource: { values: [caseDataArray] },
            auth: authClient,
          });

          let rowLink = '';
          try {
            const updatedRange = resp?.data?.updates?.updatedRange || resp?.updates?.updatedRange || '';
            const rowNumMatch = updatedRange.match(/!.*?(\d+):/);
            const rowNum = rowNumMatch ? parseInt(rowNumMatch[1], 10) : null;
            const gid = draft.type === 'Arrest Log' ? ARREST_GID : INCIDENT_GID;
            if (rowNum && gid) rowLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}&range=A${rowNum}:I${rowNum}`;
          } catch {}

          sessions.delete(key);

          await interaction.update({ content: `✅ **${draft.caseNum}** logged to Google Sheets! ${rowLink ? `[[Open row]](${rowLink})` : ''}`, components: [], embeds: [] });

          // Audit
          await logAudit(interaction.guild, `🟢 Confirmed: **${draft.caseNum}** by <@${interaction.user.id}>`, null);
        } catch (err) {
          console.error('🚨 Error logging MDT report:', err);
          await interaction.update({ content: '❌ Error logging MDT report. Check Google credentials & spreadsheet ID.', components: [], embeds: [] });
          await logAudit(interaction.guild, `🔴 Confirm failed for **${draft.caseNum}** (${err.message})`, null);
        }
      }

      if (interaction.customId === 'cancel_mdt') {
        sessions.delete(key);
        await interaction.update({ content: '❌ **MDT Report entry canceled.**', components: [], embeds: [] });
        await logAudit(interaction.guild, `🟠 Canceled draft for **${draft.caseNum}** by <@${interaction.user.id}>`, null);
      }

      if (interaction.customId === 'edit_mdt') {
        draft.messageId = interaction.message?.id || draft.messageId;
        sessions.set(key, draft);

        const modal = new ModalBuilder().setCustomId('mdt_modal').setTitle('✏️ Edit MDT Draft');

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
    }

    // ---------- 🧾 SELECT MENUS ----------
    else if (interaction.isStringSelectMenu()) {
      const key = sessionKey(interaction);
      const draft = sessions.get(key);
      if (!draft) return interaction.reply({ content: '⚠️ No active MDT draft. Use **/mdt**.', flags: MessageFlags.Ephemeral });
      if (interaction.user.id !== draft.userId) return interaction.reply({ content: '🚫 This draft belongs to another user.', flags: MessageFlags.Ephemeral });

      if (interaction.customId.startsWith('sel_charge_')) {
        // Merge selected offenses into draft.charge
        const current = parseCSVSet(draft.charge);
        for (const v of interaction.values) current.add(v);
        draft.charge = setToCSV(current);
        sessions.set(key, draft);

        // Update preview with recalculated totals
        const penalties = await readPenaltiesFromSheet();
        const pIndex = buildPenaltyIndex(penalties);
        const totals = sumPenalties(pIndex, draft.charge);
        const embed = buildMdtEmbed(draft, interaction.user, totals);
        const buttons = buildMdtButtons();
        try {
          if (draft.messageId && interaction.channel) {
            await interaction.channel.messages.edit(draft.messageId, { embeds: [embed], components: [buttons] });
          }
        } catch (e) { console.error('⚠️ Failed to edit preview message:', e); }

        return interaction.update({ content: `🧾 Added ${interaction.values.length} charge(s). Current: ${draft.charge}`, components: [], flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'sel_location') {
        draft.location = interaction.values[0];
        sessions.set(key, draft);

        const penalties = await readPenaltiesFromSheet();
        const pIndex = buildPenaltyIndex(penalties);
        const totals = sumPenalties(pIndex, draft.charge);
        const embed = buildMdtEmbed(draft, interaction.user, totals);
        const buttons = buildMdtButtons();
        try {
          if (draft.messageId && interaction.channel) {
            await interaction.channel.messages.edit(draft.messageId, { embeds: [embed], components: [buttons] });
          }
        } catch (e) { console.error('⚠️ Failed to edit preview message:', e); }

        return interaction.update({ content: `📍 Location set to **${draft.location}**.`, components: [], flags: MessageFlags.Ephemeral });
      }
    }

    // ---------- 📝 MODAL SUBMISSIONS ----------
    else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'mdt_modal') {
        const key = sessionKey(interaction);
        const draft = sessions.get(key);
        if (!draft) return interaction.reply({ content: '⚠️ Draft not found. Please run **/mdt** again.', flags: MessageFlags.Ephemeral });
        if (interaction.user.id !== draft.userId) return interaction.reply({ content: '🚫 This draft belongs to another user.', flags: MessageFlags.Ephemeral });

        draft.officer = interaction.fields.getTextInputValue('officer').trim();
        draft.suspect = interaction.fields.getTextInputValue('suspect').trim();
        draft.charge = interaction.fields.getTextInputValue('charge').trim();
        draft.location = interaction.fields.getTextInputValue('location').trim();
        draft.summary = interaction.fields.getTextInputValue('summary').trim();
        sessions.set(key, draft);

        // Recalc totals & update the thread preview
        const penalties = await readPenaltiesFromSheet();
        const pIndex = buildPenaltyIndex(penalties);
        const totals = sumPenalties(pIndex, draft.charge);
        const embed = buildMdtEmbed(draft, interaction.user, totals);
        const buttons = buildMdtButtons();
        try {
          if (draft.messageId && interaction.channel) {
            await interaction.channel.messages.edit(draft.messageId, { embeds: [embed], components: [buttons] });
          }
        } catch (e) { console.error('⚠️ Failed to edit preview message:', e); }

        await logAudit(interaction.guild, `✏️ Edited draft **${draft.caseNum}** by <@${interaction.user.id}>`, embed);
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
