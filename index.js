require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ftp = require('basic-ftp');
const { Client, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');
const { parseLine, EVENT_TYPES } = require('./parser');

// Env config
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const FTP_PATH = process.env.FTP_PATH || '/';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);
const FILE_PATTERNS = (process.env.FILE_PATTERNS || 'adminLog.xml,latest.log,*.rpt')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';
const DEBUG = String(process.env.DEBUG || 'false').toLowerCase() === 'true';
const INCLUDE_IP = String(process.env.INCLUDE_IP || 'false').toLowerCase() === 'true';

// State persistence to survive restarts
const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
ensureDir(DATA_DIR);
const state = loadState();

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.files) data.files = {};
    if (typeof data.bootstrapped !== 'boolean') {
      data.bootstrapped = Object.keys(data.files).length > 0;
    }
    return data;
  } catch (_) {
    return { files: {}, bootstrapped: false };
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to save state:', err.message);
  }
}

function globToRegex(pattern) {
  const escapedSegments = pattern
    .split('*')
    .map(seg => seg.replace(/[|\\{}()\[\]^$+?.]/g, '\\$&'));
  const regexBody = escapedSegments.join('.*');
  return new RegExp(`^${regexBody}$`, 'i');
}

function mmatch(name, patterns) {
  // Simple glob: * wildcard only
  return patterns.some(p => globToRegex(p).test(name));
}

async function listLogFiles(client) {
  await client.cd(FTP_PATH);
  const items = await client.list();
  if (DEBUG) {
    console.log('[DEBUG] Contenuto directory:', items.map(it => `${it.name}${it.isDirectory ? '/' : ''}`).join(', '));
  }
  return items
    .filter(it => it.isFile)
    .filter(it => mmatch(it.name, FILE_PATTERNS))
    .map(it => ({ name: it.name, size: it.size, modifiedAt: it.modifiedAt }));
}

async function downloadNewChunk(client, remotePath, fromOffset) {
  // Download from offset to end into a buffer
  let buf = Buffer.alloc(0);
  const writable = new (require('stream').Writable)({
    write(chunk, enc, cb) {
      buf = Buffer.concat([buf, chunk]);
      cb();
    }
  });
  await client.downloadTo(writable, remotePath, fromOffset);
  return buf.toString('utf8');
}

function pretty(text) {
  if (!text) return undefined;
  const value = String(text)
    .replace(/_/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function toEmbed(evt) {
  const time = evt.timestamp ? new Date(evt.timestamp) : new Date();
  const embed = new EmbedBuilder()
    .setTimestamp(time)
    .setColor(0x5865F2);

  switch (evt.type) {
    case EVENT_TYPES.CONNECT:
      embed.setTitle('➡️ Connessione giocatore');
      embed.setDescription((evt.player || 'Sconosciuto') + " si e' connesso al server");
      if (evt.steamId) embed.addFields({ name: 'SteamID', value: String(evt.steamId), inline: true });
      if (evt.guid) embed.addFields({ name: 'GUID', value: evt.guid, inline: true });
      if (INCLUDE_IP && evt.ip) embed.addFields({ name: 'IP', value: evt.ip, inline: true });
      if (evt.source) embed.addFields({ name: 'Fonte', value: evt.source, inline: true });
      break;
    case EVENT_TYPES.DISCONNECT:
      embed.setTitle('⬅️ Disconnessione giocatore');
      embed.setDescription((evt.player || 'Sconosciuto') + ' ha lasciato il server');
      if (evt.steamId) embed.addFields({ name: 'SteamID', value: String(evt.steamId), inline: true });
      if (evt.guid) embed.addFields({ name: 'GUID', value: evt.guid, inline: true });
      if (INCLUDE_IP && evt.ip) embed.addFields({ name: 'IP', value: evt.ip, inline: true });
      if (evt.source) embed.addFields({ name: 'Fonte', value: evt.source, inline: true });
      break;
    case EVENT_TYPES.KILL:
      embed.setTitle('💥 Uccisione');
      embed.setDescription('💥 ' + (evt.killer || 'Sconosciuto') + ' ha ucciso ' + (evt.victim || 'Sconosciuto'));
      if (evt.weapon) embed.addFields({ name: 'Arma', value: pretty(evt.weapon), inline: true });
      if (evt.location) embed.addFields({ name: 'Luogo', value: pretty(evt.location) || evt.location, inline: true });
      if (evt.distance != null) embed.addFields({ name: 'Distanza', value: String(evt.distance) + ' m', inline: true });
      if (evt.hitZone) embed.addFields({ name: 'Colpo', value: pretty(evt.hitZone), inline: true });
      break;
    case EVENT_TYPES.DEATH:
      embed.setTitle('☠️ Morte giocatore');
      {
        const cause = pretty(evt.cause) || 'causa sconosciuta';
        embed.setDescription('☠️ ' + (evt.player || 'Sconosciuto') + " e' stato ucciso da " + cause);
      }
      if (evt.location) embed.addFields({ name: 'Luogo', value: pretty(evt.location) || evt.location, inline: true });
      break;
    case EVENT_TYPES.CHAT:
      embed.setTitle('🗨️ Chat in game');
      embed.addFields(
        { name: 'Canale', value: evt.channel || 'N/D', inline: true },
        { name: 'Player', value: evt.player || 'Sconosciuto', inline: true },
        { name: 'Messaggio', value: evt.message || '-' }
      );
      break;
    case EVENT_TYPES.ADMIN:
      embed.setTitle('⚡ Evento admin');
      {
        const actor = evt.actor || evt.source || 'Admin';
        const action = evt.action || 'azione';
        const targetInfo = evt.target ? ' su ' + evt.target : '';
        embed.setDescription('⚡ ' + actor + ' ha eseguito ' + action + targetInfo);
      }
      if (evt.reason) embed.addFields({ name: 'Motivo', value: pretty(evt.reason) });
      if (evt.source && evt.actor !== evt.source) {
        embed.addFields({ name: 'Fonte', value: evt.source, inline: true });
      }
      break;
    case EVENT_TYPES.POSITION:
      embed.setTitle('📍 Posizione giocatore');
      embed.addFields(
        { name: 'Player', value: evt.player || 'Sconosciuto', inline: true },
        { name: 'Coordinate', value: evt.coords || evt.location || 'N/D', inline: true }
      );
      break;
    case EVENT_TYPES.PLAYER_COUNT:
      embed.setTitle('👥 Giocatori online');
      embed.setDescription('👥 Totale: ' + (evt.count != null ? String(evt.count) : 'N/D'));
      break;
    case EVENT_TYPES.PLAYER_LIST_HEADER:
      embed.setTitle('🗺️ Snapshot giocatori');
      embed.addFields(
        { name: 'Orario log', value: evt.snapshot || 'N/D', inline: true },
        { name: 'Parte', value: String(evt.part || 1), inline: true }
      );
      break;
    default:
      embed.setTitle('Evento');
      embed.setDescription(evt.raw?.slice(0, 2000) || '');
  }

  return embed;
}

function chunkToLines(chunk) {
  // Normalize newlines and trim trailing empty
  const lines = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  return lines.filter(l => l && l.trim().length > 0);
}

let channelRef = null;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function buildStatusEmbed(status) {
  const online = status === 'online';
  return new EmbedBuilder()
    .setTitle(online ? 'Bot online' : 'Bot offline')
    .setDescription(online ? 'DayZ log watcher avviato.' : 'DayZ log watcher arrestato.')
    .setColor(online ? 0x57F287 : 0xED4245)
    .setTimestamp(new Date());
}

client.once(Events.ClientReady, async () => {
  try {
    channelRef = await client.channels.fetch(DISCORD_CHANNEL_ID);
    console.log(`Discord: Logged in as ${client.user.tag}. Channel: ${channelRef?.id}`);
    if (channelRef && !DRY_RUN) {
      await channelRef.send({ embeds: [buildStatusEmbed('online')] });
    }
  } catch (err) {
    console.error('Discord channel fetch failed:', err.message);
  }
  // Start polling after discord is ready
  setTimeout(tick, 2000);
  setInterval(tick, POLL_INTERVAL_MS);
});

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  const ftpClient = new ftp.Client(20 * 1000);
  ftpClient.ftp.verbose = false;
  try {
    await ftpClient.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      secure: false
    });

    const files = await listLogFiles(ftpClient);
    if (DEBUG) {
      console.log(`[DEBUG] Collegato FTP. File corrispondenti: ${files.length}`);
      if (!files.length) {
        console.log('[DEBUG] Nessun file trovato con i pattern attuali.');
      }
    }
    for (const f of files) {
      const remoteRel = f.name; // we already cd into FTP_PATH
      const key = path.posix.join(FTP_PATH.replace(/\\/g, '/'), f.name);
      if (DEBUG) {
        console.log(`[DEBUG] File ${remoteRel}: size=${f.size}`);
      }
      let fileState = state.files[key];
      if (!fileState) {
        if (!state.bootstrapped) {
          state.files[key] = { offset: f.size, updatedAt: Date.now() };
          if (DEBUG) {
            console.log(`[DEBUG] ${remoteRel}: primo avvio, salto ${f.size} byte.`);
          }
          saveState();
          continue;
        }
        fileState = state.files[key] = { offset: 0, updatedAt: Date.now() };
        saveState();
      }
      const last = fileState.offset || 0;
      // Handle rotation: if smaller than last, reset
      const from = f.size < last ? 0 : last;
      if (f.size === from) {
        if (DEBUG) {
          console.log(`[DEBUG] ${remoteRel}: nessuna nuova riga (offset ${from}).`);
        }
        continue; // nothing new
      }

      let chunk = '';
      try {
        chunk = await downloadNewChunk(ftpClient, remoteRel, from);
      } catch (err) {
        console.error(`Download failed for ${remoteRel}:`, err.message);
        continue;
      }

      const lines = chunkToLines(chunk);
      const events = [];
      if (DEBUG) {
        console.log(`[DEBUG] ${remoteRel}: offset ${from} -> ${f.size}, linee nuove=${lines.length}`);
      }
      for (const line of lines) {
        const evt = parseLine(guessLogType(f.name), line);
        if (evt) {
          events.push(evt);
        } else if (DEBUG) {
          console.log(`[DEBUG] Nessun match: ${line}`);
        }
      }

      if (!events.length && DEBUG) {
        console.log(`[DEBUG] ${remoteRel}: nessun evento da inviare.`);
      }

      // Post to Discord
      for (const evt of events) {
        if (DRY_RUN) {
          console.log(`[DRY] ${evt.type}:`, JSON.stringify(evt));
        } else if (channelRef) {
          try {
            await channelRef.send({ embeds: [toEmbed(evt)] });
          } catch (err) {
            console.error('Discord send failed:', err.message);
          }
        }
      }

      // Update offset
      state.files[key] = { offset: f.size, updatedAt: Date.now() };
      saveState();
      if (DEBUG) {
        console.log(`[DEBUG] ${remoteRel}: eventi inviati=${events.length}`);
      }
    }
    if (!state.bootstrapped) {
      state.bootstrapped = true;
      saveState();
      if (DEBUG) {
        console.log('[DEBUG] Bootstrap completato: i log precedenti sono stati ignorati.');
      }
    }
  } catch (err) {
    console.error('Tick error:', err.message);
    if (DEBUG) {
      console.error(err);
    }
  } finally {
    ftpClient.close();
    ticking = false;
  }
}

function guessLogType(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xml') || lower.includes('adminlog')) return 'adminxml';
  if (lower.endsWith('.rpt')) return 'rpt';
  return 'text';
}

function validateEnv() {
  const missing = [];
  if (!DISCORD_TOKEN) missing.push('DISCORD_TOKEN');
  if (!DISCORD_CHANNEL_ID) missing.push('DISCORD_CHANNEL_ID');
  if (!FTP_HOST) missing.push('FTP_HOST');
  if (!FTP_USER) missing.push('FTP_USER');
  if (!FTP_PASS) missing.push('FTP_PASS');
  if (missing.length) {
    console.error('Missing required env vars:', missing.join(', '));
    process.exit(1);
  }
}

validateEnv();
client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err.message);
  process.exit(1);
});

// Graceful shutdown to announce offline
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (channelRef && !DRY_RUN) {
      await channelRef.send({ embeds: [buildStatusEmbed('offline')] });
    }
  } catch (_) { /* ignore */ }
  try { await client.destroy(); } catch (_) { /* ignore */ }
  // Allow a short delay to flush
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
