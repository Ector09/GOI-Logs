// Lightweight parser for DayZ server logs
// Tries to extract readable events: connect, disconnect, kill, death, chat, admin
// Note: Log formats vary by server/version; adjust regex as needed for your setup.

const EVENT_TYPES = {
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  KILL: 'kill',
  DEATH: 'death',
  CHAT: 'chat',
  ADMIN: 'admin',
  POSITION: 'position',
  PLAYER_COUNT: 'player_count',
  PLAYER_LIST_HEADER: 'player_list_header'
};

function clean(s) {
  if (!s && s !== 0) return undefined;
  return String(s).trim().replace(/^\"|\"$/g, '');
}

function sanitizePlayer(name) {
  const value = clean(name);
  if (!value) return undefined;
  let result = value
    .replace(/^['\"]+|['\"]+$/g, '')
    .replace(/\b\(DEAD\)\b/gi, '')
    .replace(/\b\(ALIVE\)\b/gi, '')
    .replace(/\(id=[^)]+\)/gi, '')
    .replace(/\bID=\d+\b/gi, '')
    .replace(/\bcharID=\d+\b/gi, '')
    .replace(/\(dpnid=[^)]+\)/gi, '')
    .replace(/\bSteamID\s*=\s*\d+/gi, '')
    .replace(/\bidentity:[^,]+/gi, '')
    .replace(/\bpos=<[^>]+>/gi, '')
    .replace(/\bpos\s*=\s*<[^>]+>/gi, '')
    .replace(/\(pos=<[^>]+>\)/gi, '')
    .replace(/\s+(?:has|was)\s+(?:been\s+)?(?:connected|disconnected|kicked|banned).*/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[-–—\s]+/, '')
    .trim();
  if (!result) return undefined;
  return result;
}

function parseTimestamp(line) {
  // Attempt to extract a timestamp prefix like: "2025-09-19 23:41:02" or "23:41:02"
  const iso = line.match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/);
  if (iso) return new Date(iso[1]);
  const time = line.match(/\b(\d{2}:\d{2}:\d{2})\b/);
  if (time) {
    const now = new Date();
    const [hh, mm, ss] = time[1].split(':').map(Number);
    now.setHours(hh, mm, ss, 0);
    return now;
  }
  return new Date();
}

// Attempt to parse location in various textual forms
function parseLocation(line) {
  // Examples: "near Berezino", "at Berezino", "pos=<1234.5,678.9,101.1>"
  const named = line.match(/\b(?:near|at)\s+([A-Za-z][A-Za-z0-9_\- ]{2,})/i);
  if (named) return clean(named[1]);
  const pos = line.match(/pos\s*=\s*<\s*([^>]+)\s*>/i);
  if (pos) return clean(pos[1]);
  const coords = line.match(/\bat\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?))?/i);
  if (coords) {
    const [, x, y, z] = coords;
    return [x, y, z].filter(Boolean).join(', ');
  }
  return undefined;
}

function parseWeapon(line) {
  // Examples: "with M4A1", "by weapon M4A1"
  const m = line.match(/\bwith\s+([A-Za-z0-9_\-\. ]{2,})\b/i) || line.match(/\bweapon\s+([A-Za-z0-9_\-\. ]{2,})\b/i);
  return m ? clean(m[1]) : undefined;
}

function parseSteamId(line) {
  const m = line.match(/\b(?:steamid|steam)\s*[:=]?\s*(\d{17})\b/i) || line.match(/\((\d{17})\)/);
  return m ? clean(m[1]) : undefined;
}

function parseDistance(line) {
  const m = line.match(/\b(?:distance|dist)\s*[:=]?\s*(\d{1,4})\s*m\b/i) || line.match(/\((\d{1,4})m\)/i);
  return m ? Number(m[1]) : undefined;
}

function parseHitZone(line) {
  const m = line.match(/\bhit\s*(?:zone|part)?\s*[:=]?\s*([A-Za-z]+)/i) || line.match(/\bheadshot\b/i);
  if (!m) return undefined;
  if (typeof m === 'string') return 'Head';
  const v = clean(m[1]);
  return v ? v[0].toUpperCase() + v.slice(1) : v;
}

function parseIpPort(line) {
  const ip = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b/);
  if (!ip) return undefined;
  return `${ip[1]}:${ip[2]}`;
}

function parseGuid(line) {
  // Some logs may show GUID-like 32-hex or separate field
  const m = line.match(/\bGUID\s*[:=]?\s*([A-Fa-f0-9]{8,})\b/);
  return m ? clean(m[1]) : undefined;
}

function parseAdminActor(line) {
  const tag = line.match(/\[(?:Admin|GM)\]\s*([^:]+):/i);
  if (tag) return clean(tag[1]);
  const byAdmin = line.match(/\bby\s+admin\s+['\"]?([^'\";]+)['\"]?/i);
  if (byAdmin) return clean(byAdmin[1]);
  const adminField = line.match(/\badmin[:=]\s*['\"]?([^'\";]+)['\"]?/i);
  if (adminField) return clean(adminField[1]);
  const issued = line.match(/\bissued\s+by\s+['\"]?([^'\";]+)['\"]?/i);
  if (issued) return clean(issued[1]);
  return undefined;
}

function parseConnectDisconnect(line) {
  // Flexible patterns: "Player John connected", "John has been disconnected", "(Connected) John"
  let m = line.match(/\bPlayer\s+['\"]?(.+?)['\"]?\s+connected\b/i) ||
          line.match(/\b(['\"]?[^'\"]]+['\"]?)\s+has\s+connected\b/i) ||
          line.match(/\bjoined\s+the\s+game:\s*(['\"]?[^'\"]]+['\"]?)/i) ||
          line.match(/\bPlayer\s*#\d+\s+(.+?)\s+connected\b/i);
  if (m) {
    return {
      type: EVENT_TYPES.CONNECT,
      player: sanitizePlayer(m[1]),
      steamId: parseSteamId(line),
      guid: parseGuid(line),
      ip: parseIpPort(line)
    };
  }

  m = line.match(/\bPlayer\s+['\"]?(.+?)['\"]?\s+disconnected\b/i) ||
      line.match(/\b(['\"]?[^'\"]]+['\"]?)\s+has\s+been\s+disconnected\b/i) ||
      line.match(/\bleft\s+the\s+game:\s*(['\"]?[^'\"]]+['\"]?)/i) ||
      line.match(/\bPlayer\s*#\d+\s+(.+?)\s+disconnected\b/i);
  if (m) {
    return {
      type: EVENT_TYPES.DISCONNECT,
      player: sanitizePlayer(m[1]),
      steamId: parseSteamId(line),
      guid: parseGuid(line),
      ip: parseIpPort(line)
    };
  }
  return null;
}

function parseKillDeath(line) {
  // Kill: "Killer killed Victim with Weapon near Location"
  let m = line.match(/\b(.+?)\s+killed\s+(.+?)\b/i) || line.match(/\b(.+?)\s+was\s+killed\s+by\s+(.+?)\b/i);
  if (m) {
    // If pattern is "Victim was killed by Killer", swap
    const isPassive = /was\s+killed\s+by/i.test(line);
    const a = clean(m[1]);
    const b = clean(m[2]);
    const killer = sanitizePlayer(isPassive ? b : a);
    const victim = sanitizePlayer(isPassive ? a : b);
    const weapon = parseWeapon(line);
    const location = parseLocation(line);
    const distance = parseDistance(line);
    const hitZone = parseHitZone(line);
    const steamIds = (line.match(/\d{17}/g) || []).map(clean);
    const killerSteamId = isPassive ? steamIds[1] : steamIds[0];
    const victimSteamId = isPassive ? steamIds[0] : steamIds[1];
    return {
      type: EVENT_TYPES.KILL,
      killer,
      victim,
      weapon,
      location,
      distance,
      hitZone,
      steamId: killerSteamId,
      killerSteamId,
      victimSteamId
    };
  }

  // Death (environmental): "Player died", "Player is dead", "suicide"
  m = line.match(/\b(['\"]?[^'\"]+['\"]?)\s+(?:died|is\s+dead|suicide[d]?|bled\s+out|starv(?:ed|ing)|drown(?:ed|ing))\b/i);
  if (m) {
    const player = clean(m[1]);
    const location = parseLocation(line);
    const cause = (line.match(/\bby\s+([A-Za-z]+)/i) || line.match(/\b(?:cause|reason)\s*[:=]\s*([A-Za-z ]+)/i) || [])[1];
    const steamId = parseSteamId(line);
    return {
      type: EVENT_TYPES.DEATH,
      player: sanitizePlayer(player),
      location,
      cause: clean(cause),
      steamId
    };
  }
  return null;
}

function parseChat(line) {
  // Examples:
  // "(Direct) John: hello"
  // "Chat: (Global) John: \"hello\""
  const m = line.match(/\((Direct|Vehicle|Global|Side|Group|Admin)\)\s+([^:]+):\s+"?(.+?)"?$/i) ||
            line.match(/\bChat:\s*\(([^)]+)\)\s*([^:]+):\s+"?(.+?)"?$/i);
  if (m) {
    const channel = clean(m[1]);
    const player = sanitizePlayer(m[2]);
    const message = clean(m[3]);
    return {
      type: EVENT_TYPES.CHAT,
      channel,
      player,
      message
    };
  }
  return null;
}

function parseBattlEye(line) {
  if (!/BattlEye Server:/i.test(line)) return null;
  const steamId = parseSteamId(line);
  const ip = parseIpPort(line);
  // Connect/Disconnect
  let m = line.match(/BattlEye Server:\s*Player\s*#\d+\s+(.+?)\s+connected/i);
  if (m) {
    return {
      type: EVENT_TYPES.CONNECT,
      player: sanitizePlayer(m[1]),
      source: 'BattlEye',
      steamId,
      ip
    };
  }
  m = line.match(/BattlEye Server:\s*Player\s*#\d+\s+(.+?)\s+disconnected/i);
  if (m) {
    return {
      type: EVENT_TYPES.DISCONNECT,
      player: sanitizePlayer(m[1]),
      source: 'BattlEye',
      steamId,
      ip
    };
  }
  // Kick/Ban with reason
  m = line.match(/BattlEye Server:\s*Player\s*#\d+\s+(.+?)\s+(?:was\s+)?kicked:?\s*\(?([^)]*)\)?/i);
  if (m) {
    return {
      type: EVENT_TYPES.ADMIN,
      action: 'kick',
      target: sanitizePlayer(m[1]),
      reason: clean(m[2]),
      source: 'BattlEye',
      actor: 'BattlEye',
      steamId,
      ip
    };
  }
  m = line.match(/BattlEye Server:\s*Player\s*#\d+\s+(.+?)\s+(?:has\s+been\s+)?banned:?\s*\(?([^)]*)\)?/i);
  if (m) {
    return {
      type: EVENT_TYPES.ADMIN,
      action: 'ban',
      target: sanitizePlayer(m[1]),
      reason: clean(m[2]),
      source: 'BattlEye',
      actor: 'BattlEye',
      steamId,
      ip
    };
  }
  // High ping or BE-related kick reasons
  m = line.match(/BattlEye Server:\s*Player\s*#\d+\s+(.+?)\s+was\s+kicked\s+for\s+(.+)/i);
  if (m) {
    return {
      type: EVENT_TYPES.ADMIN,
      action: 'kick',
      target: sanitizePlayer(m[1]),
      reason: clean(m[2]),
      source: 'BattlEye',
      actor: 'BattlEye',
      steamId,
      ip
    };
  }
  return null;
}

function parsePosition(line) {
  // Examples: "John was spotted at 1363.5, 9658.0" or "Player John at 2001.4, 9393.6"
  let m = line.match(/\b(.+?)\s+was\s+spotted\s+at\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?))?/i);
  if (m) {
    const player = sanitizePlayer(m[1]);
    const coords = [m[2], m[3], m[4]].filter(Boolean).join(', ');
    return { type: EVENT_TYPES.POSITION, player, coords };
  }

  m = line.match(/\bPlayer\s+['\"]?(.+?)['\"]?\s+(?:is\s+)?at\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?))?/i);
  if (m) {
    const player = sanitizePlayer(m[1]);
    const coords = [m[2], m[3], m[4]].filter(Boolean).join(', ');
    return { type: EVENT_TYPES.POSITION, player, coords };
  }

  return null;
}

function parseScriptPosition(line) {
  // Lines from script logs: "player Name (dpnid=..., ...) pos=<1234.5, 678.9, 101.1>"
  const m = line.match(/\bplayer\s+([^\(]+?)\s*\(.*?pos\s*=\s*<\s*([^>]+)\s*>/i);
  if (m) {
    const player = sanitizePlayer(m[1]);
    const coords = clean(m[2]);
    return {
      type: EVENT_TYPES.POSITION,
      player,
      coords
    };
  }

  // Alternative format: "Player Name pos=1234.5 678.9 101.1"
  const alt = line.match(/\bplayer\s+([^:]+?)\s+pos\s*=\s*([-\d\.\s,]+)/i);
  if (alt) {
    const player = sanitizePlayer(alt[1]);
    const coords = clean(alt[2]).replace(/\s+/g, ', ');
    return {
      type: EVENT_TYPES.POSITION,
      player,
      coords
    };
  }

  return null;
}

function parsePlayerCount(line) {
  const m = line.match(/Total Players\s*:\s*(\d+)/i) || line.match(/Players Online\s*[:=]\s*(\d+)/i);
  if (!m) return null;
  return {
    type: EVENT_TYPES.PLAYER_COUNT,
    count: Number(m[1])
  };
}

function parsePlayerListHeader(line) {
  const m = line.match(/Latest Admin Player List\s*-\s*([^\-]+?)\s*-\s*Part\s*(\d+)/i);
  if (!m) return null;
  return {
    type: EVENT_TYPES.PLAYER_LIST_HEADER,
    snapshot: clean(m[1]),
    part: Number(m[2])
  };
}

function parseAdmin(line) {
  // Admin events: kick, ban, restart, shutdown, rcon actions
  let m = line.match(/\b(kick(?:ed)?|ban(?:ned)?|restart(?:ed)?|shutdown|restarting|stopping|start(?:ed)?)\b/i);
  if (m) {
    const action = m[1].toLowerCase();
    // Try to grab target player if present
    const target = (line.match(/\bplayer\s+['\"]?([^'\"]]+)['\"]?/i) || line.match(/\b(['\"]?[^'\"]+['\"]?)\s+kick(?:ed)?\b/i) || [])[1];
    const reason = (line.match(/\breason\s*[:=]\s*([^;]+)\b/i) || [])[1];
    return {
      type: EVENT_TYPES.ADMIN,
      action,
      target: clean(target),
      reason: clean(reason),
      actor: parseAdminActor(line)
    };
  }
  return null;
}

function parseLine(logType, line) {
  const timestamp = parseTimestamp(line);
  const base = { raw: line, timestamp };

  // Try patterns in order of specificity
  const parsers = [
    parseKillDeath,
    parseScriptPosition,
    parsePosition,
    parsePlayerCount,
    parsePlayerListHeader,
    parseBattlEye,
    parseConnectDisconnect,
    parseChat,
    parseAdmin
  ];
  for (const fn of parsers) {
    const evt = fn(line);
    if (evt) return { ...base, ...evt };
  }
  return null;
}

module.exports = {
  EVENT_TYPES,
  parseLine
};
