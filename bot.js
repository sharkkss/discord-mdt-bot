// ￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣
// 🚔 MDT BOT — Full Upgrade (Public/Private + Persistent + Modal + Guards + Threads + Autocomplete + Admin)
// ￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣
// Included:
// - Public/Private toggle for /mdt (boolean option)
// - Persistent case numbers per day & type (scan Sheets safely; re-check on confirm)
// - ✏️ Edit Modal before confirm
// - Role & Channel guard (per-guild, configurable via /config and/or Config sheet)
// - Drafts persisted to a "Drafts" tab + auto-timeout (15 min, configurable)
// - Auto-thread per case; moves preview into thread
// - Audit-log channel for confirm/cancel
// - Dynamic autocomplete for charges/officers/locations from Sheets
// - Quick-pick select menus for charges & locations
// - Sheet row link on confirmation (uses tab GIDs from config)
// - Auto-calculated fines/jail from a Penalties table
// - /case get | addnote | close (status column J, optional K/L for closer/time)
// - /config show | set (writes to Config tab; per-guild)
// ￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣￣

// ------------------ 🚦 KEEP-ALIVE SERVER ------------------
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (_req, res) => res.send('✅ MDT Bot running — Ready!'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.listen(port, () => console.log(`🛰️ Keep-alive on ${port}`));

// ------------------ 🤖 DISCORD + 📗 GOOGLE SHEETS SETUP ------------------
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
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
  MessageFlags,
} = require('discord.js');
const { google } = require('googleapis');

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN');
  process.exit(1);
}
if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
  console.error('❌ Missing GOOGLE_SHEETS_CREDENTIALS');
  process.exit(1);
}

const googleCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);

// ⚙️ App + guild config
const clientId = '1437985374398840873';
const guildIds = [
  '1024627335707762688', // test server
  '1072289637000814632', // second server
];

// 📄 Sheets API
const sheets = google.sheets('v4');
const DEFAULT_SPREADSHEET_ID = '1VrYFm0EquJGNkyqo1OuLUWEUtPmnU1_B0cWZ0t1g7n8';
const RANGES = {
  config: 'Config!A2:O',     // guildId | spreadsheetId | auditChannelId | allowedChannelIds | allowedRoleIds | previewDefault | arrestTab | incidentTab | arrestGid | incidentGid | chargesRange | officersRange | locationsRange | timeoutMinutes | maxAttachmentMB
  penalties: 'Penalties!A2:C', // Charge | Fine | Jail
  chargesFallback: 'Config!A2:A',
  officersFallback: 'Config!B2:B',
  locationsFallback: 'Config!C2:C',
  drafts: 'Drafts!A2:N',     // guildId | userId | caseNum | type | date | officer | suspect | charge | location | evidence | summary | imageURL | expiresAt | messageId
  notes: 'Notes!A2:E',       // caseNum | author | note | timestamp | guildId
};
const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// 🔐 Guards
const DEFAULT_TIMEOUT_MINUTES = 15;
const DEFAULT_MAX_ATTACHMENT_MB = 8;

// 🧮 Time helpers
const tz = 'Asia/Manila';
const nowPH = () => new Date().toLocaleString('en-PH', { timeZone: tz });
const datePH = () => new Date().toLocaleDateString('en-PH', { timeZone: tz });
const tsISO = () => new Date().toISOString();
const yyyymmddPH = () => {
  const d = new Date();
  const y = d.toLocaleString('en-PH', { timeZone: tz, year: 'numeric' });
  const m = d.toLocaleString('en-PH', { timeZone: tz, month: '2-digit' });
  const da = d.toLocaleString('en-PH', { timeZone: tz, day: '2-digit' });
  return `${y}${m}${da}`;
};

// 🤝 Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// 🗂️ Per-user session drafts (guild-scoped, in-memory)
const sessions = new Map(); // key: `${userId}:${guildId}` -> draft
const sKey = (g, u) => `${u}:${g}`;

// ------------- SHEETS HELPERS -------------
async function getAuth() { return auth.getClient(); }
async function readValues(spreadsheetId, range) {
  const authClient = await getAuth();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range, auth: authClient });
  return res.data.values || [];
}
async function appendValues(spreadsheetId, range, values) {
  const authClient = await getAuth();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId, range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    includeValuesInResponse: true,
    responseValueRenderOption: 'UNFORMATTED_VALUE',
    resource: { values: Array.isArray(values[0]) ? values : [values] },
    auth: authClient,
  });
  return res.data; // includes updates.updatedRange
}
async function updateValues(spreadsheetId, range, values) {
  const authClient = await getAuth();
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId, range,
    valueInputOption: 'RAW',
    resource: { values: Array.isArray(values[0]) ? values : [values] },
    auth: authClient,
  });
  return res.data;
}
async function clearRange(spreadsheetId, range) {
  const authClient = await getAuth();
  await sheets.spreadsheets.values.clear({ spreadsheetId, range, auth: authClient });
}

// ------------- CONFIG -------------
async function getGuildConfig(guildId) {
  const rows = await readValues(DEFAULT_SPREADSHEET_ID, RANGES.config);
  const row = rows.find(r => (r[0] || '').trim() === String(guildId));
  const cfg = {
    spreadsheetId: row?.[1] || DEFAULT_SPREADSHEET_ID,
    auditChannelId: row?.[2] || '',
    allowedChannelIds: (row?.[3] || '').split(',').map(s=>s.trim()).filter(Boolean),
    allowedRoleIds: (row?.[4] || '').split(',').map(s=>s.trim()).filter(Boolean),
    previewDefault: (row?.[5] || 'public').toLowerCase(), // 'public' | 'private'
    arrestTab: row?.[6] || 'Arrest Log',
    incidentTab: row?.[7] || 'Incident Report',
    arrestGid: row?.[8] || '',
    incidentGid: row?.[9] || '',
    chargesRange: row?.[10] || 'Config!A2:A',
    officersRange: row?.[11] || 'Config!B2:B',
    locationsRange: row?.[12] || 'Config!C2:C',
    timeoutMinutes: parseInt(row?.[13] || DEFAULT_TIMEOUT_MINUTES, 10),
    maxAttachmentMB: parseInt(row?.[14] || DEFAULT_MAX_ATTACHMENT_MB, 10),
  };
  return cfg;
}
async function setGuildConfig(guildId, patch) {
  const rows = await readValues(DEFAULT_SPREADSHEET_ID, RANGES.config);
  const idx = rows.findIndex(r => (r[0] || '').trim() === String(guildId));
  const arr = new Array(15).fill('');
  arr[0] = String(guildId);
  if (idx >= 0) {
    const row = rows[idx];
    for (let i=1;i<=14;i++) arr[i] = row?.[i] ?? '';
  }
  const map = {
    spreadsheetId: 1, auditChannelId: 2, allowedChannelIds: 3, allowedRoleIds: 4,
    previewDefault: 5, arrestTab: 6, incidentTab: 7, arrestGid: 8, incidentGid: 9,
    chargesRange: 10, officersRange: 11, locationsRange: 12, timeoutMinutes: 13, maxAttachmentMB: 14,
  };
  Object.entries(patch).forEach(([k,v]) => {
    const col = map[k]; if (col == null) return;
    if (Array.isArray(v)) arr[col] = v.join(',');
    else arr[col] = String(v ?? '');
  });

  const rowIndex = idx >= 0 ? idx + 2 : rows.length + 2;
  const range = `Config!A${rowIndex}:O${rowIndex}`;
  await updateValues(DEFAULT_SPREADSHEET_ID, range, [arr]);
}

// ------------- LOOKUPS & PENALTIES -------------
async function fetchList(spreadsheetId, range, fallbackRange) {
  try {
    const rows = await readValues(spreadsheetId, range);
    return rows.flat().map(s => String(s).trim()).filter(Boolean);
  } catch {
    const rows = await readValues(spreadsheetId, fallbackRange);
    return rows.flat().map(s => String(s).trim()).filter(Boolean);
  }
}
async function fetchPenalties(spreadsheetId) {
  const rows = await readValues(spreadsheetId, RANGES.penalties);
  const map = {};
  for (const r of rows) {
    const charge = (r?.[0] || '').trim();
    if (!charge) continue;
    const fine = Number(r?.[1] || 0);
    const jail = Number(r?.[2] || 0);
    map[charge.toLowerCase()] = { charge, fine, jail };
  }
  return map;
}
function sumPenalties(penaltiesMap, chargeText) {
  const list = String(chargeText || '').split(',').map(s => s.trim()).filter(Boolean);
  const totals = { fine: 0, jail: 0, items: [] };
  for (const c of list) {
    const p = penaltiesMap[c.toLowerCase()];
    if (p) { totals.fine += p.fine; totals.jail += p.jail; totals.items.push(`${p.charge} (₱${p.fine} | ${p.jail}m)`); }
  }
  return totals;
}

// ------------- CASE NUMBERS -------------
async function getNextCaseSeq(cfg, type) {
  const tab = type === 'Arrest Log' ? cfg.arrestTab : cfg.incidentTab;
  const spreadsheetId = cfg.spreadsheetId;
  const day = yyyymmddPH();
  const prefix = type === 'Arrest Log' ? 'AL' : 'IR';
  const start = `${prefix}-${day}-`;
  const range = `${tab}!A2:A`;
  const rows = await readValues(spreadsheetId, range);
  const seqs = rows
    .map(r => (r?.[0] || ''))
    .filter(v => v.startsWith(start))
    .map(v => parseInt(v.split('-').pop(), 10))
    .filter(n => Number.isFinite(n));
  const maxSeq = seqs.length ? Math.max(...seqs) : 999;
  return maxSeq + 1;
}

// ------------- DRAFTS PERSISTENCE -------------
async function saveDraftRow(cfg, draft) {
  const values = [
    draft.guildId, draft.userId, draft.caseNum, draft.type, draft.date,
    draft.officer, draft.suspect, draft.charge, draft.location, draft.evidence,
    draft.summary || '', draft.evidenceImage?.url || '', draft.expiresAt || '', draft.messageId || ''
  ];
  await appendValues(cfg.spreadsheetId, RANGES.drafts.replace('A2', 'A1'), values);
}
async function findDraftRows(cfg, guildId, userId) {
  const rows = await readValues(cfg.spreadsheetId, RANGES.drafts);
  const matches = [];
  rows.forEach((r, i) => {
    if ((r?.[0]||'') === String(guildId) && (r?.[1]||'') === String(userId)) {
      matches.push({ rowIndex: i + 2, row: r });
    }
  });
  return matches;
}
async function clearDraftByKey(cfg, guildId, userId, caseNum) {
  const rows = await readValues(cfg.spreadsheetId, RANGES.drafts);
  const idx = rows.findIndex(r => (r?.[0]||'') === String(guildId) && (r?.[1]||'') === String(userId) && (r?.[2]||'') === String(caseNum));
  if (idx >= 0) {
    const rowNum = idx + 2;
    const range = `Drafts!A${rowNum}:N${rowNum}`;
    await clearRange(cfg.spreadsheetId, range);
  }
}

// ------------- UI BUILDERS -------------
function buildMdtEmbed(cfg, draft, user, penaltiesTotals) {
  const embed = new EmbedBuilder()
    .setColor(0x00a3ff)
    .setTitle(`${draft.type === 'Arrest Log' ? '🚔 Arrest Log' : '📝 Incident Report'} — Review & Confirm`)
    .setAuthor({ name: `${user.username} • ${nowPH()} (PH)`, iconURL: user.displayAvatarURL({ forceStatic: false }) })
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
    .setFooter({ text: '✅ Confirm • ✏️ Edit • ➕ Select menus to fill • ❌ Cancel' })
    .setTimestamp();
  if (penaltiesTotals) {
    embed.addFields(
      { name: '💸 Total Fine', value: `₱${penaltiesTotals.fine}`, inline: true },
      { name: '⏱️ Jail Time', value: `${penaltiesTotals.jail} min`, inline: true },
    );
  }
  if (draft.imageInfo) {
    embed.addFields({ name: '🖼️ Evidence File', value: draft.imageInfo, inline: false });
  }
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
function buildPickMenus(chargeList = [], locationList = []) {
  const rows = [];
  if (chargeList.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('select_charge')
      .setPlaceholder('Quick-pick: common charges')
      .setMinValues(1)
      .setMaxValues(Math.min(5, chargeList.length))
      .addOptions(chargeList.slice(0, 25).map(c => ({ label: c.slice(0,100), value: c.slice(0,100) })));
    rows.push(new ActionRowBuilder().addComponents(menu));
  }
  if (locationList.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('select_location')
      .setPlaceholder('Quick-pick: common locations')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(locationList.slice(0, 25).map(c => ({ label: c.slice(0,100), value: c.slice(0,100) })));
    rows.push(new ActionRowBuilder().addComponents(menu));
  }
  return rows;
}

// ------------- GUARDS -------------
function hasRole(member, ids) {
  if (!ids?.length) return true;
  return member?.roles?.cache?.some(r => ids.includes(r.id));
}
function inChannel(channelId, allowed) {
  if (!allowed?.length) return true;
  return allowed.includes(channelId);
}

// ------------- AUDIT LOG -------------
async function audit(cfg, guild, content) {
  if (!cfg.auditChannelId) return;
  try {
    const ch = guild.channels.cache.get(cfg.auditChannelId) || await guild.channels.fetch(cfg.auditChannelId).catch(()=>null);
    if (ch) ch.send({ content });
  } catch {}
}

// ------------- CASE HELPERS -------------
function tabForType(cfg, type) {
  return type === 'Arrest Log' ? cfg.arrestTab : cfg.incidentTab;
}
function gidForType(cfg, type) {
  return type === 'Arrest Log' ? cfg.arrestGid : cfg.incidentGid;
}
async function findCaseRow(cfg, caseNum) {
  const tabs = [cfg.arrestTab, cfg.incidentTab];
  for (const tab of tabs) {
    const rows = await readValues(cfg.spreadsheetId, `${tab}!A2:Z`);
    const idx = rows.findIndex(r => (r?.[0]||'') === caseNum);
    if (idx >= 0) return { tab, rowIndex: idx + 2, row: rows[idx] };
  }
  return null;
}

// ------------------ 🚀 BOT READY EVENT ------------------
client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag} | 🕒 ${nowPH()} (PH)`);

  client.user.setPresence({ activities: [{ name: '🚓 MDT on duty | /mdt', type: 0 }], status: 'online' });

  // Slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('mdt')
      .setDescription('🚓 Start the MDT process')
      .addStringOption(opt =>
        opt.setName('type').setDescription('Type of report').setRequired(true)
           .addChoices({ name: 'Arrest Log', value: 'Arrest Log' }, { name: 'Incident Report', value: 'Incident Report' })
      )
      .addStringOption(opt => opt.setName('officer').setDescription('Officer name').setRequired(true).setAutocomplete(true))
      .addStringOption(opt => opt.setName('suspect').setDescription('Suspect name').setRequired(true))
      .addStringOption(opt => opt.setName('charge').setDescription('Charge or incident').setRequired(true).setAutocomplete(true))
      .addStringOption(opt => opt.setName('location').setDescription('Location').setRequired(true).setAutocomplete(true))
      .addStringOption(opt => opt.setName('evidence').setDescription('Evidence details').setRequired(true))
      .addStringOption(opt => opt.setName('summary').setDescription('Summary or note').setRequired(false))
      .addAttachmentOption(opt => opt.setName('evidenceimage').setDescription('Evidence image'))
      .addBooleanOption(opt => opt.setName('private').setDescription('Make this preview private (ephemeral)?').setRequired(false)),

    new SlashCommandBuilder()
      .setName('officerstats')
      .setDescription('📊 View officer stats')
      .addStringOption(opt => opt.setName('officer').setDescription('Officer name').setRequired(true).setAutocomplete(true)),

    new SlashCommandBuilder()
      .setName('case')
      .setDescription('🔎 Case operations')
      .addSubcommand(sub => sub.setName('get').setDescription('Get a case by number').addStringOption(o => o.setName('number').setDescription('Case number').setRequired(true)))
      .addSubcommand(sub => sub.setName('addnote').setDescription('Add a note to a case')
        .addStringOption(o => o.setName('number').setDescription('Case number').setRequired(true))
        .addStringOption(o => o.setName('note').setDescription('Note').setRequired(true)))
      .addSubcommand(sub => sub.setName('close').setDescription('Close a case by number').addStringOption(o => o.setName('number').setDescription('Case number').setRequired(true))),

    new SlashCommandBuilder()
      .setName('config')
      .setDescription('🛠️ Configure guild settings')
      .addSubcommand(sub => sub.setName('show').setDescription('Show current config'))
      .addSubcommand(sub => sub.setName('set').setDescription('Set config values')
        .addStringOption(o => o.setName('spreadsheet').setDescription('Spreadsheet ID'))
        .addStringOption(o => o.setName('auditchannel').setDescription('Audit channel ID'))
        .addStringOption(o => o.setName('allowedchannels').setDescription('Comma-separated channel IDs'))
        .addStringOption(o => o.setName('allowedroles').setDescription('Comma-separated role IDs'))
        .addStringOption(o => o.setName('previewdefault').setDescription('public|private'))
        .addStringOption(o => o.setName('arresttab').setDescription('Arrest tab name'))
        .addStringOption(o => o.setName('incidenttab').setDescription('Incident tab name'))
        .addStringOption(o => o.setName('arrestgid').setDescription('Arrest tab GID'))
        .addStringOption(o => o.setName('incidentgid').setDescription('Incident tab GID'))
        .addStringOption(o => o.setName('chargesrange').setDescription('Range for charges (e.g., Config!A2:A)'))
        .addStringOption(o => o.setName('officersrange').setDescription('Range for officers (e.g., Config!B2:B)'))
        .addStringOption(o => o.setName('locationsrange').setDescription('Range for locations (e.g., Config!C2:C)'))
        .addIntegerOption(o => o.setName('timeoutminutes').setDescription('Draft timeout in minutes'))
        .addIntegerOption(o => o.setName('maxattachmentmb').setDescription('Max evidence size in MB'))),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  for (const id of guildIds) {
    try { await rest.put(Routes.applicationGuildCommands(clientId, id), { body: commands }); console.log(`🧭 Commands registered for guild ${id} ✅`); }
    catch (err) { console.error(`🚨 Failed to register commands for ${id}:`, err); }
  }
});

// ------------------ 🧩 INTERACTION HANDLER ------------------
client.on('interactionCreate', async (interaction) => {
  try {
    // ---------- Autocomplete ----------
    if (interaction.isAutocomplete()) {
      const cfg = await getGuildConfig(interaction.guildId);
      const focused = interaction.options.getFocused(true);
      const q = (focused.value || '').toLowerCase();
      let list = [];
      if (focused.name === 'charge') list = await fetchList(cfg.spreadsheetId, cfg.chargesRange, RANGES.chargesFallback);
      if (focused.name === 'officer') list = await fetchList(cfg.spreadsheetId, cfg.officersRange, RANGES.officersFallback);
      if (focused.name === 'location') list = await fetchList(cfg.spreadsheetId, cfg.locationsRange, RANGES.locationsFallback);
      const match = list.filter(x => x.toLowerCase().includes(q)).slice(0, 25);
      return interaction.respond(match.map(x => ({ name: x, value: x })));
    }

    // ---------- Slash Commands ----------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      const cfg = await getGuildConfig(interaction.guildId);

      // Role/Channel guard
      if (!inChannel(interaction.channelId, cfg.allowedChannelIds)) {
        const hint = cfg.allowedChannelIds.map(id => `<#${id}>`).join(', ');
        return interaction.reply({ content: `🔒 Please use this in: ${hint || 'an allowed channel'}`, flags: MessageFlags.Ephemeral });
      }
      if (!hasRole(interaction.member, cfg.allowedRoleIds)) {
        return interaction.reply({ content: `🔒 You don’t have permission to use this command.`, flags: MessageFlags.Ephemeral });
      }

      if (commandName === 'mdt') {
        const makePrivate = interaction.options.getBoolean('private') ?? (cfg.previewDefault === 'private');
        if (makePrivate) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        else await interaction.deferReply();

        const type = interaction.options.getString('type');
        const officer = interaction.options.getString('officer');
        const suspect = interaction.options.getString('suspect');
        const charge = interaction.options.getString('charge');
        const location = interaction.options.getString('location');
        const evidence = interaction.options.getString('evidence');
        const summary = interaction.options.getString('summary');
        const attachment = interaction.options.getAttachment('evidenceimage');

        // Evidence guardrails
        let evidenceImage = null;
        let imageInfo = null;
        if (attachment) {
          const size = attachment.size || 0; // bytes
          const mb = cfg.maxAttachmentMB || DEFAULT_MAX_ATTACHMENT_MB;
          const maxBytes = mb * 1024 * 1024;
          const ct = (attachment.contentType || '').toLowerCase();
          const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].some(t => ct.includes(t));
          if (!ok) imageInfo = `⚠️ Non-image attachment (${ct || 'unknown type'}).`;
          else if (size > maxBytes) imageInfo = `⚠️ File too large (${(size/1024/1024).toFixed(2)} MB > ${mb} MB).`;
          else {
            evidenceImage = attachment;
            imageInfo = `🖼️ ${(size/1024).toFixed(0)} KB • ${ct || 'image'}`;
          }
        }

        // Load lookups for quick-pick
        const [chargesList, locationsList, penaltiesMap] = await Promise.all([
          fetchList(cfg.spreadsheetId, cfg.chargesRange, RANGES.chargesFallback),
          fetchList(cfg.spreadsheetId, cfg.locationsRange, RANGES.locationsFallback),
          fetchPenalties(cfg.spreadsheetId),
        ]);

        const day = yyyymmddPH();
        const prefix = type === 'Arrest Log' ? 'AL' : 'IR';
        const nextSeq = await getNextCaseSeq(cfg, type);
        const caseNum = `${prefix}-${day}-${nextSeq}`;
        const draft = {
          guildId: interaction.guildId,
          userId: interaction.user.id,
          type, caseNum, seq: nextSeq, date: datePH(),
          officer: officer?.trim(), suspect: suspect?.trim(), charge: charge?.trim(), location: location?.trim(),
          evidence: evidence?.trim(), summary: (summary || '').trim(),
          evidenceImage, imageInfo,
          expiresAt: Date.now() + (cfg.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES) * 60 * 1000,
          messageId: null, threadId: null, private: makePrivate,
        };

        sessions.set(sKey(draft.guildId, draft.userId), draft);
        await saveDraftRow(cfg, draft);

        const totals = sumPenalties(penaltiesMap, draft.charge);
        const embed = buildMdtEmbed(cfg, draft, interaction.user, totals);
        const buttons = buildMdtButtons();
        const pickRows = buildPickMenus(chargesList, locationsList);

        // Create thread for the case and move preview
        const thread = await interaction.channel.threads.create({ name: draft.caseNum, autoArchiveDuration: 1440 });
        draft.threadId = thread.id;
        sessions.set(sKey(draft.guildId, draft.userId), draft);

        await interaction.editReply({ content: `🧵 Moved preview to thread: <#${thread.id}>`, embeds: [], components: [] });
        const msg = await thread.send({ embeds: [embed], components: [buttons, ...pickRows] });
        draft.messageId = msg.id;
        sessions.set(sKey(draft.guildId, draft.userId), draft);
      }

      if (commandName === 'officerstats') {
        await interaction.deferReply();
        const officerName = interaction.options.getString('officer');
        try {
          const authClient = await getAuth();
          const arrestReq = { spreadsheetId: cfg.spreadsheetId, range: `${cfg.arrestTab}!A2:I`, auth: authClient };
          const incidentReq = { spreadsheetId: cfg.spreadsheetId, range: `${cfg.incidentTab}!A2:I`, auth: authClient };
          const [arrestRes, incidentRes] = await Promise.all([
            sheets.spreadsheets.values.get(arrestReq),
            sheets.spreadsheets.values.get(incidentReq),
          ]);
          const arrestRows = arrestRes.data.values || [];
          const incidentRows = incidentRes.data.values || [];
          const nameLC = officerName.toLowerCase();
          const arrestCases = arrestRows.filter(r => (r?.[2]||'').toLowerCase() === nameLC).length;
          const incidentCases = incidentRows.filter(r => (r?.[2]||'').toLowerCase() === nameLC).length;
          const totalCases = arrestCases + incidentCases;
          const embed = new EmbedBuilder()
            .setColor(0x00a3ff).setTitle(`📊 ${officerName}'s Stats`)
            .addFields(
              { name: '🧮 Total Cases', value: `**${totalCases}**`, inline: true },
              { name: '👮 Arrests', value: `${arrestCases}`, inline: true },
              { name: '📝 Incident Reports', value: `${incidentCases}`, inline: true },
            ).setFooter({ text: `Updated • ${nowPH()} (PH)` }).setTimestamp();
          await interaction.editReply({ embeds: [embed] });
        } catch (err) {
          console.error('🚨 officerstats:', err);
          await interaction.editReply('❌ Error fetching officer stats.');
        }
      }

      if (commandName === 'case') {
        const sub = interaction.options.getSubcommand();
        const number = interaction.options.getString('number');
        if (sub === 'get') {
          const found = await findCaseRow(cfg, number);
          if (!found) return interaction.reply({ content: `❓ Case **${number}** not found.`, flags: MessageFlags.Ephemeral });
          const row = found.row;
          const embed = new EmbedBuilder()
            .setColor(0x00a3ff)
            .setTitle(`📁 ${number}`)
            .addFields(
              { name: '📅 Date', value: String(row?.[1]||'-'), inline: true },
              { name: '👮 Officer', value: String(row?.[2]||'-'), inline: true },
              { name: '🧍 Suspect', value: String(row?.[3]||'-'), inline: true },
              { name: '⚖️ Charge', value: String(row?.[4]||'-'), inline: false },
              { name: '📍 Location', value: String(row?.[5]||'-'), inline: true },
              { name: '🧾 Evidence', value: String(row?.[6]||'-'), inline: false },
              { name: '🗒️ Summary', value: String(row?.[7]||'-') || '—', inline: false },
            );
          if (row?.[8]) embed.setImage(String(row[8]));
          await interaction.reply({ embeds: [embed] });
        }
        if (sub === 'addnote') {
          const note = interaction.options.getString('note');
          await appendValues(cfg.spreadsheetId, RANGES.notes.replace('A2','A1'), [number, `${interaction.user.username}#${interaction.user.discriminator}`, note, tsISO(), interaction.guildId]);
          await interaction.reply({ content: `📝 Note added to **${number}**.` });
        }
        if (sub === 'close') {
          const found = await findCaseRow(cfg, number);
          if (!found) return interaction.reply({ content: `❓ Case **${number}** not found.`, flags: MessageFlags.Ephemeral });
          const rowNum = found.rowIndex;
          await updateValues(cfg.spreadsheetId, `${found.tab}!J${rowNum}:L${rowNum}`, [['Closed', `${interaction.user.username}`, nowPH()]]);
          await interaction.reply({ content: `🔒 Case **${number}** closed.` });
          await audit(cfg, interaction.guild, `🔒 ${number} closed by ${interaction.user.tag}`);
        }
      }

      if (commandName === 'config') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'show') {
          const c = await getGuildConfig(interaction.guildId);
          const embed = new EmbedBuilder()
            .setColor(0x00a3ff)
            .setTitle('🛠️ Guild Config')
            .addFields(
              { name: 'Spreadsheet', value: c.spreadsheetId, inline: false },
              { name: 'Audit Channel', value: c.auditChannelId || '—', inline: true },
              { name: 'Allowed Channels', value: c.allowedChannelIds.join(', ') || '—', inline: true },
              { name: 'Allowed Roles', value: c.allowedRoleIds.join(', ') || '—', inline: true },
              { name: 'Preview Default', value: c.previewDefault, inline: true },
              { name: 'Tabs', value: `Arrest: ${c.arrestTab} (gid ${c.arrestGid||'—'})\nIncident: ${c.incidentTab} (gid ${c.incidentGid||'—'})`, inline: false },
              { name: 'Lookups', value: `Charges: ${c.chargesRange}\nOfficers: ${c.officersRange}\nLocations: ${c.locationsRange}`, inline: false },
              { name: 'Timeout / Max MB', value: `${c.timeoutMinutes} min / ${c.maxAttachmentMB} MB`, inline: true },
            );
          return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
        if (sub === 'set') {
          const patch = {
            spreadsheetId: interaction.options.getString('spreadsheet') ?? undefined,
            auditChannelId: interaction.options.getString('auditchannel') ?? undefined,
            allowedChannelIds: interaction.options.getString('allowedchannels')?.split(',').map(s=>s.trim()).filter(Boolean),
            allowedRoleIds: interaction.options.getString('allowedroles')?.split(',').map(s=>s.trim()).filter(Boolean),
            previewDefault: interaction.options.getString('previewdefault') ?? undefined,
            arrestTab: interaction.options.getString('arresttab') ?? undefined,
            incidentTab: interaction.options.getString('incidenttab') ?? undefined,
            arrestGid: interaction.options.getString('arrestgid') ?? undefined,
            incidentGid: interaction.options.getString('incidentgid') ?? undefined,
            chargesRange: interaction.options.getString('chargesrange') ?? undefined,
            officersRange: interaction.options.getString('officersrange') ?? undefined,
            locationsRange: interaction.options.getString('locationsrange') ?? undefined,
            timeoutMinutes: interaction.options.getInteger('timeoutminutes') ?? undefined,
            maxAttachmentMB: interaction.options.getInteger('maxattachmentmb') ?? undefined,
          };
          Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);
          await setGuildConfig(interaction.guildId, patch);
          return interaction.reply({ content: '✅ Config updated.', flags: MessageFlags.Ephemeral });
        }
      }
    }

    // ---------- Button Interactions ----------
    if (interaction.isButton()) {
      const cfg = await getGuildConfig(interaction.guildId);
      const key = sKey(interaction.guildId, interaction.user.id);
      const draft = sessions.get(key);
      if (!draft) return interaction.reply({ content: '⚠️ No active MDT draft. Use **/mdt**.', flags: MessageFlags.Ephemeral });
      if (Date.now() > draft.expiresAt) {
        sessions.delete(key);
        await clearDraftByKey(cfg, draft.guildId, draft.userId, draft.caseNum);
        return interaction.update({ content: '⌛ Draft expired. Please start again with **/mdt**.', components: [], embeds: [] });
      }

      if (interaction.customId === 'edit_mdt') {
        const modal = new ModalBuilder().setCustomId('mdt_modal').setTitle('✏️ Edit MDT Draft');
        const mkShort = (id, label, value, required = true) =>
          new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setValue((value || '').slice(0,100));
        const mkLong = (id, label, value, required = false) =>
          new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(required).setValue((value || '').slice(0,1024));
        modal.addComponents(
          new ActionRowBuilder().addComponents(mkShort('officer','Officer',draft.officer)),
          new ActionRowBuilder().addComponents(mkShort('suspect','Suspect',draft.suspect)),
          new ActionRowBuilder().addComponents(mkShort('charge','Charge / Incident',draft.charge)),
          new ActionRowBuilder().addComponents(mkShort('location','Location',draft.location)),
          new ActionRowBuilder().addComponents(mkLong('summary','Summary (optional)',draft.summary,false)),
        );
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'cancel_mdt') {
        sessions.delete(key);
        await clearDraftByKey(cfg, draft.guildId, draft.userId, draft.caseNum);
        await audit(cfg, interaction.guild, `🗑️ ${draft.caseNum} canceled by ${interaction.user.tag}`);
        return interaction.update({ content: '❌ MDT draft canceled.', components: [], embeds: [] });
      }

      if (interaction.customId === 'confirm_mdt') {
        const nextSeq = await getNextCaseSeq(cfg, draft.type);
        const day = yyyymmddPH();
        const prefix = draft.type === 'Arrest Log' ? 'AL' : 'IR';
        draft.seq = nextSeq;
        draft.caseNum = `${prefix}-${day}-${nextSeq}`;

        const tab = tabForType(cfg, draft.type);
        const dataRow = [
          draft.caseNum, draft.date, draft.officer, draft.suspect, draft.charge, draft.location,
          draft.evidence, draft.summary || 'No summary provided', draft.evidenceImage?.url || 'No image provided',
        ];
        const resp = await appendValues(cfg.spreadsheetId, `${tab}!A1`, dataRow);
        let rowLink = '';
        try {
          const updatedRange = resp?.updates?.updatedRange || '';
          const rowNum = parseInt(updatedRange.match(/!.*?(\d+):/)[1], 10);
          const gid = gidForType(cfg, draft.type);
          if (gid) rowLink = `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}/edit#gid=${gid}&range=A${rowNum}:I${rowNum}`;
        } catch {}

        sessions.delete(key);
        await clearDraftByKey(cfg, draft.guildId, draft.userId, draft.caseNum);
        await audit(cfg, interaction.guild, `✅ ${draft.caseNum} confirmed by ${interaction.user.tag}`);

        return interaction.update({
          content: `✅ **${draft.caseNum}** logged to Google Sheets! ${rowLink ? `[[Open row]](${rowLink})` : ''}`,
          components: [], embeds: [],
        });
      }
    }

    // ---------- Select Menus ----------
    if (interaction.isStringSelectMenu()) {
      const cfg = await getGuildConfig(interaction.guildId);
      const key = sKey(interaction.guildId, interaction.user.id);
      const draft = sessions.get(key);
      if (!draft) return interaction.reply({ content: '⚠️ No active MDT draft. Use **/mdt**.', flags: MessageFlags.Ephemeral });

      if (interaction.customId === 'select_charge') {
        const picked = interaction.values;
        let current = draft.charge ? draft.charge.split(',').map(s=>s.trim()).filter(Boolean) : [];
        for (const p of picked) if (!current.includes(p)) current.push(p);
        draft.charge = current.join(', ');
      }
      if (interaction.customId === 'select_location') {
        draft.location = interaction.values[0];
      }
      sessions.set(key, draft);

      try {
        const penaltiesMap = await fetchPenalties(cfg.spreadsheetId);
        const totals = sumPenalties(penaltiesMap, draft.charge);
        const embed = buildMdtEmbed(cfg, draft, interaction.user, totals);
        const channel = await client.channels.fetch(draft.threadId);
        await channel.messages.edit(draft.messageId, { embeds: [embed] });
      } catch {}

      return interaction.reply({ content: '✅ Updated.', flags: MessageFlags.Ephemeral });
    }

    // ---------- Modal Submissions ----------
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'mdt_modal') {
        const cfg = await getGuildConfig(interaction.guildId);
        const key = sKey(interaction.guildId, interaction.user.id);
        const draft = sessions.get(key);
        if (!draft) return interaction.reply({ content: '⚠️ Draft not found. Start **/mdt** again.', flags: MessageFlags.Ephemeral });

        draft.officer = interaction.fields.getTextInputValue('officer').trim();
        draft.suspect = interaction.fields.getTextInputValue('suspect').trim();
        draft.charge = interaction.fields.getTextInputValue('charge').trim();
        draft.location = interaction.fields.getTextInputValue('location').trim();
        draft.summary = interaction.fields.getTextInputValue('summary').trim();
        sessions.set(key, draft);

        try {
          const penaltiesMap = await fetchPenalties(cfg.spreadsheetId);
          const totals = sumPenalties(penaltiesMap, draft.charge);
          const embed = buildMdtEmbed(cfg, draft, interaction.user, totals);
          const channel = await client.channels.fetch(draft.threadId);
          await channel.messages.edit(draft.messageId, { embeds: [embed] });
        } catch (e) { console.error('edit preview failed', e); }

        return interaction.reply({ content: '✅ Draft updated.', flags: MessageFlags.Ephemeral });
      }
    }
  } catch (err) {
    console.error('⚠️ interaction error:', err);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.editReply('⚠️ Something went wrong.');
        else await interaction.reply({ content: '⚠️ Something went wrong.', flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('🔐 Login successful.'))
  .catch((e) => console.error('🔐 Login failed:', e));
