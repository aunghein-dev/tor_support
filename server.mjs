import express from "express";
import WebTorrent from "webtorrent";
import path from "path";
import { fileURLToPath } from 'url';
import os from 'os';
import cors from "cors";
import NodeCache from "node-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

const client = new WebTorrent({
  maxConns: 20,
  nodeId: undefined,
  peerId: undefined,
  tracker: true,
  dht: false,
  webSeeds: true,
  path: path.join(os.tmpdir(), 'webtorrent', Date.now().toString())
});

// --- Caches ---
const torrentMap = new Map(); 
const subtitleCache = new NodeCache({ stdTTL: 86400 }); 
const liveMatchesCache = new NodeCache({ stdTTL: 60 }); // 1 minute cache for live matches

const OPENSUBTITLES_API_KEY = "RxPfsDLz24QZiE4A4WgwGE2XHcvz4Rng";

// Rate limiting
const requestCounts = new Map();
const RATE_LIMIT = 200;
const RATE_LIMIT_WINDOW = 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;

  if (!requestCounts.has(ip)) requestCounts.set(ip, []);
  const requests = requestCounts.get(ip).filter(time => time > windowStart);
  requests.push(now);
  requestCounts.set(ip, requests);

  if (requests.length > RATE_LIMIT) {
    return res.status(429).json({ error: "Too many requests" });
  }
  next();
}

app.use(rateLimit);

// --- Team Matching Utilities ---
const TEAM_ALIASES = [
  // AFC Champions League Teams
  { primary: "Gangwon FC", aliases: ["gangwon"] },
  { primary: "Vissel Kobe", aliases: ["vissel kobe"] },
  { primary: "Shanghai Shenhua FC", aliases: ["shanghai shenhua"] },
  { primary: "FC Seoul", aliases: ["fc seoul", "seoul"] },
  { primary: "Gamba Osaka", aliases: ["gamba osaka"] },
  { primary: "Thep Xanh Nam Dinh FC", aliases: ["nam dinh fc", "thep xanh nam dinh"] },
  { primary: "Ratchaburi FC", aliases: ["ratchaburi"] },
  { primary: "Eastern", aliases: ["eastern"] },
  
  // UEFA Champions League Teams
  { primary: "Athletic Club", aliases: ["athletic bilbao", "bilbao"] },
  { primary: "Qarabag", aliases: ["qarabag fk", "fk qarabag"] },
  { primary: "Galatasaray", aliases: ["galatasaray"] },
  { primary: "Bodo Glimt", aliases: ["bodo glimt"] },
  { primary: "Chelsea", aliases: ["chelsea"] },
  { primary: "AFC Ajax", aliases: ["ajax", "afc ajax"] },
  { primary: "Eintracht Frankfurt", aliases: ["eintracht frankfurt"] },
  { primary: "Liverpool", aliases: ["liverpool"] },
  { primary: "AS Monaco", aliases: ["as monaco", "monaco"] },
  { primary: "Tottenham Hotspur", aliases: ["tottenham", "tottenham hotspur"] },
  { primary: "Atalanta", aliases: ["atalanta"] },
  { primary: "Slavia Praha", aliases: ["slavia praha"] },
  { primary: "Real Madrid", aliases: ["real madrid"] },
  { primary: "Juventus", aliases: ["juventus"] },
  { primary: "FC Bayern Munich", aliases: ["bayern munchen", "bayern munich", "fc bayern munich"] },
  { primary: "Club Brugge", aliases: ["club brugge"] },
  { primary: "Sporting CP", aliases: ["sporting lisbon", "sporting cp"] },
  { primary: "Marseille", aliases: ["marseille"] },

  // Other notable teams
  { primary: "Al Nassr FC", aliases: ["al nassr riyadh", "al nassr"] },
  { primary: "FC Goa", aliases: ["fc goa"] },
  { primary: "Esteghlal Tehran", aliases: ["esteghlal"] },
  { primary: "Al Wehdat", aliases: ["al wehdat amman"] },
  { primary: "Al-Ahli Doha", aliases: ["al ahli doha"] },
  { primary: "Arkadag FK", aliases: ["fk arkadag"] },
  { primary: "Persib Bandung", aliases: ["persib bandung"] },
  { primary: "Selangor FC", aliases: ["selangor"] },
  { primary: "BG Pathum United", aliases: ["bg pathum united"] },
  { primary: "Beijing Guoan FC", aliases: ["beijing guoan fc"] },
  { primary: "Pohang Steelers", aliases: ["pohang steelers"] },

  // Indonesian Teams
  { primary: "PSIM Yogyakarta", aliases: ["psim yogyakarta"] },
  { primary: "Dewa United FC", aliases: ["dewa united fc"] },
];

const LEAGUE_MAPPINGS = {
  "ACL Elite": ["afc champions league elite", "acl elite"],
  "ACL2": ["afc champions league two", "acl2"],
  "UEFA CL": ["uefa champions league", "champions league"],
  "UEFA YL": ["uefa youth league"],
  "IDN D1": ["indonesia super league", "indonesia liga 1"],
  "TUR D1": ["turkey super league", "super lig"],
  "EGY D1": ["egypt premier league"],
  "FIN D1": ["finland veikkausliiga"],
  "RUS Cup": ["russia cup"],
  "NBA": ["nba"],
  "NBL": ["nbl"],
  "KBL": ["kbl"],
  "MPBL": ["mpbl"],
};

function normalizeTeamName(name) {
  if (!name) return '';
  
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLeagueName(name) {
  if (!name) return '';
  
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findTeamMatch(teamName) {
  const normalized = normalizeTeamName(teamName);
  
  for (const team of TEAM_ALIASES) {
    // Check primary name
    if (normalizeTeamName(team.primary) === normalized) {
      return team.primary;
    }
    
    // Check aliases
    for (const alias of team.aliases) {
      if (normalizeTeamName(alias) === normalized) {
        return team.primary;
      }
    }
  }
  
  return teamName; // Return original if no match found
}

function findLeagueMatch(leagueName) {
  const normalized = normalizeLeagueName(leagueName);
  
  for (const [key, aliases] of Object.entries(LEAGUE_MAPPINGS)) {
    if (aliases.some(alias => normalizeLeagueName(alias) === normalized)) {
      return key;
    }
  }
  
  return leagueName; // Return original if no match found
}

function calculateSimilarity(a, b) {
  const aNorm = normalizeTeamName(a);
  const bNorm = normalizeTeamName(b);
  
  if (aNorm === bNorm) return 1.0;
  
  const aWords = new Set(aNorm.split(' '));
  const bWords = new Set(bNorm.split(' '));
  
  let intersection = 0;
  for (const word of aWords) {
    if (bWords.has(word)) intersection++;
  }
  
  const union = new Set([...aWords, ...bWords]).size;
  return union > 0 ? intersection / union : 0;
}

// --- Live Matches Constants ---
const RESULT_PARENT_URL = "https://sport.ibet288.com/_view/Result.aspx";
const BASE_URL = "https://json.vnres.co";

// --- Live Matches API ---
app.get("/live", async (req, res) => {
  try {
    // Check cache first
    const cached = liveMatchesCache.get('matches');
    if (cached) {
      return res.json(cached);
    }

    const dates = [
      formatDate(Date.now()),
      formatDate(Date.now() + 72_000_000), // 20 hours ahead
    ];

    const ibetResults = await getCachedIbetResults();
    const matchGroups = await Promise.all(
      dates.map((d) => fetchMatches(d, ibetResults))
    );

    const allMatches = matchGroups.flat();
    
    // Cache the results for 1 minute
    liveMatchesCache.set('matches', allMatches, 60);

    res.json(allMatches);
  } catch (err) {
    console.error("[API] Live fetch error:", err);
    res.status(500).json({ 
      error: "Server error", 
      message: err.message 
    });
  }
});

// --- Live Matches Helpers ---
function formatDate(ms) {
  const dt = new Date(ms);
  const formatted = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Yangon" }).format(dt);
  return formatted.replace(/-/g, "");
}

let ibetCache = null;

async function getCachedIbetResults() {
  const now = Date.now();
  if (ibetCache && now - ibetCache.timestamp < 3 * 60 * 1000) {
    return ibetCache.data;
  }
  
  try {
    const results = await fetchIbetResults();
    ibetCache = { timestamp: now, data: results };
    return results;
  } catch (error) {
    console.warn("⚠️ iBet fetch failed, using cache if available:", error);
    return ibetCache?.data || [];
  }
}

async function fetchIbetResults() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(RESULT_PARENT_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://www.google.com/",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();
    const tableMatch = html.match(/<table[^>]*id="g1"[^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) return [];

    const rows = tableMatch[1].split(/<\/tr>/i);
    let currentLeague = "";
    const scores = [];

    for (const row of rows) {
      if (/class="?Event"?/i.test(row)) {
        const league = row.replace(/<[^>]+>/g, "").trim();
        if (league) currentLeague = league;
      } else if (/class="?Normal"?/i.test(row)) {
        const cols = row.split(/<\/td>/i).map((c) => c.replace(/<[^>]+>/g, "").trim());
        if (cols.length >= 5 && cols[1] && cols[3]) {
          scores.push({
            league: applyAliases(currentLeague),
            home: applyAliases(cols[1]),
            away: applyAliases(cols[3]),
            ft: cols[2] || null,
            ht: cols[4] || null,
          });
        }
      }
    }

    return scores;
  } catch (err) {
    console.warn("⚠️ iBet fetch failed:", err.message);
    return [];
  }
}

async function fetchMatches(date, ibetResults) {
  const cacheKey = `matches_${date}`;
  const cached = liveMatchesCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 120_000) {
    return cached.data;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${BASE_URL}/match/matches_${date}.json`, {
      headers: { 
        referer: "https://socolivev.co/", 
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        origin: BASE_URL 
      },
      signal: controller.signal,
      cache: "no-store",
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const txt = await res.text();
    const m = txt.match(/matches_\d+\((.*)\)/);
    if (!m) return [];

    const js = JSON.parse(m[1]);
    if (js.code !== 200) return [];

    const now = Math.floor(Date.now() / 1000);
    const results = await Promise.all(
      js.data.map(async (it) => {
        const mt = Math.floor(it.matchTime / 1000);
        const status =
          now >= mt && now <= mt + 7200 ? "live" : now > mt + 7200 ? "finished" : "vs";

        const ibet = findIbetScore(ibetResults, it.subCateName, it.hostName, it.guestName);
        const match_score =
          ibet.ft && ibet.ft !== "-"
            ? ibet.ft
            : it.homeScore != null && it.awayScore != null
            ? `${it.homeScore} - ${it.awayScore}`
            : null;
        const ht_score = ibet.ht && ibet.ht !== "-" ? ibet.ht : null;

        const servers = status === "live" ? await fetchAllServerURLs(it.anchors) : [];

        const ibetMatchStatus = ibet.ft || ibet.ht ? "FOUND" : "NOT_FOUND";

        return {
          match_time: formatMatchTime(mt),
          match_status: status,
          home_team_name: it.hostName,
          home_team_logo: it.hostIcon,
          away_team_name: it.guestName,
          away_team_logo: it.guestIcon,
          league_name: it.subCateName,
          match_score,
          ht_score,
          servers,
          debug: {
            original_league: it.subCateName,
            original_home: it.hostName,
            original_away: it.guestName,
            ibet_match: ibetMatchStatus,
          },
        };
      })
    );

    liveMatchesCache.set(cacheKey, { timestamp: Date.now(), data: results });
    return results;
  } catch (err) {
    console.warn(`⚠️ VNRes ${date} error:`, err.message);
    return liveMatchesCache.get(cacheKey)?.data || [];
  }
}

async function fetchAllServerURLs(anchors) {
  const results = [];
  
  if (!anchors || anchors.length === 0) {
    return results;
  }

  await Promise.allSettled(
    anchors.map(async (a) => {
      if (!a.anchor?.roomNum) return;
      
      try {
        const s = await fetchServerURL(a.anchor.roomNum);
        if (s.m3u8) results.push({ name: "480p", stream_url: s.m3u8 });
        if (s.hdM3u8) results.push({ name: "1080p", stream_url: s.hdM3u8 });
      } catch (error) {
        console.warn(`Failed to fetch server URL for room ${a.anchor.roomNum}:`, error);
      }
    })
  );
  
  return results;
}

async function fetchServerURL(roomNum) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`https://json.vnres.co/room/${roomNum}/detail.json`, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://socolivev.co/",
        "Origin": "https://socolivev.co",
      },
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const txt = await res.text();
    const m = txt.match(/detail\((.*)\)/);
    if (!m) return { m3u8: null, hdM3u8: null };
    
    const js = JSON.parse(m[1]);
    return { 
      m3u8: js.data?.stream?.m3u8 ?? null, 
      hdM3u8: js.data?.stream?.hdM3u8 ?? null 
    };
  } catch {
    return { m3u8: null, hdM3u8: null };
  }
}

function formatMatchTime(unixSeconds) {
  const dt = new Date(unixSeconds * 1000);
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Yangon",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(dt);
  return formatted;
}

function normalizeName(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
}

const ALIASES = {
  sg: "super giant",
  acl2: "afc champions league 2",
  utd: "united",
  mun: "manchester united",
};

function applyAliases(raw) {
  return normalizeName(raw)
    .split(" ")
    .map((w) => ALIASES[w] ?? w)
    .join(" ");
}

function findIbetScore(ibetResults, league, home, away) {
  if (!ibetResults || ibetResults.length === 0) {
    return { ft: null, ht: null };
  }

  const aLeague = applyAliases(findLeagueMatch(league));
  const aHome = applyAliases(findTeamMatch(home));
  const aAway = applyAliases(findTeamMatch(away));

  let best = null;
  let bestScore = 0;

  for (const row of ibetResults) {
    const score =
      calculateSimilarity(aLeague, row.league) +
      calculateSimilarity(aHome, row.home) +
      calculateSimilarity(aAway, row.away);

    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  return best && bestScore >= 0.6 ? { ft: best.ft, ht: best.ht } : { ft: null, ht: null };
}

// --- Torrent Management ---
/*
function getTorrent(torrentUrl) {
  return new Promise((resolve, reject) => {
    const cacheKey = `torrent_${Buffer.from(torrentUrl).toString('base64')}`;

    if (torrentMap.has(cacheKey)) {
      const cached = torrentMap.get(cacheKey);
      cached.lastAccessed = Date.now();
      return resolve(cached.torrent);
    }

    const torrent = client.add(torrentUrl, {
      path: path.join(os.tmpdir(), 'webtorrent', Date.now().toString()),
      storeCacheSlots: 30
    });

    const wrapper = { torrent, lastAccessed: Date.now() };
    torrentMap.set(cacheKey, wrapper);

    torrent.on('ready', () => resolve(torrent));
    torrent.on('error', (err) => {
      console.error('Torrent error:', err);
      torrentMap.delete(cacheKey);
      reject(err);
    });

  });
}
  */

function getTorrent(torrentUrl) {
  return new Promise((resolve, reject) => {
    // Decode the URL first to handle any double-encoding
    try {
      torrentUrl = decodeURIComponent(torrentUrl);
    } catch (e) {
      console.log('URL was not encoded, using as-is');
    }

    const cacheKey = `torrent_${Buffer.from(torrentUrl).toString('base64')}`;

    if (torrentMap.has(cacheKey)) {
      const cached = torrentMap.get(cacheKey);
      cached.lastAccessed = Date.now();
      return resolve(cached.torrent);
    }

    // Validate torrent URL before adding
    if (!torrentUrl || (typeof torrentUrl === 'string' && torrentUrl.trim().length === 0)) {
      return reject(new Error('Invalid torrent URL: empty or null'));
    }

    let torrent;
    try {
      // Try different methods to add the torrent
      if (torrentUrl.startsWith('magnet:')) {
        torrent = client.add(torrentUrl, {
          path: path.join(os.tmpdir(), 'webtorrent', Date.now().toString()),
          storeCacheSlots: 30
        });
      } else if (torrentUrl.startsWith('http')) {
        // For HTTP URLs, let WebTorrent handle the download
        torrent = client.add(torrentUrl, {
          path: path.join(os.tmpdir(), 'webtorrent', Date.now().toString()),
          storeCacheSlots: 30
        });
      } else {
        // Assume it's a info hash or other identifier
        torrent = client.add(torrentUrl, {
          path: path.join(os.tmpdir(), 'webtorrent', Date.now().toString()),
          storeCacheSlots: 30
        });
      }
    } catch (error) {
      console.error('Error adding torrent:', error);
      return reject(new Error(`Failed to add torrent: ${error.message}`));
    }

    const wrapper = { torrent, lastAccessed: Date.now() };
    torrentMap.set(cacheKey, wrapper);

    torrent.on('ready', () => {
      console.log(`✅ Torrent ready: ${torrent.name}`);
      resolve(torrent);
    });
    
    torrent.on('error', (err) => {
      console.error('Torrent error:', err);
      torrentMap.delete(cacheKey);
      reject(err);
    });

    // Timeout for torrent readiness
    const timeout = setTimeout(() => {
      torrentMap.delete(cacheKey);
      reject(new Error('Torrent readiness timeout'));
    }, 30000); // 30 second timeout

    torrent.on('ready', () => {
      clearTimeout(timeout);
    });

  });
}


setInterval(() => {
  const now = Date.now();
  for (const [key, { torrent, lastAccessed }] of torrentMap.entries()) {
    if (now - lastAccessed > 15 * 60 * 1000) {
      console.log("🧹 Cleaning up torrent:", torrent.name);
      torrent.destroy({ destroyStore: true });
      torrentMap.delete(key);
    }
  }
}, 10 * 60 * 1000);

// --- Enhanced Subtitle Search with Duration Matching ---
async function searchSubtitles(movieTitle, fileSize, imdbId, duration, lang = "eng") { 
  const cacheKey = `subs_${imdbId}_${lang}_${fileSize}_${duration}`;
  const cached = subtitleCache.get(cacheKey);
  if (cached) return cached;

  try {
    const searchParams = new URLSearchParams({
      languages: lang,
      order_by: 'download_count',
      order_direction: 'desc'
    });

    if (imdbId) {
      searchParams.append('imdb_id', imdbId.replace('tt', '')); 
    } else {
      searchParams.append('query', movieTitle);
    }

    const searchResponse = await fetch(`https://api.opensubtitles.com/api/v1/subtitles?${searchParams}`, {
      headers: {  
        'Api-Key': OPENSUBTITLES_API_KEY,
        'User-Agent': 'StreamFlix v1.0'
      }
    });

    if (!searchResponse.ok) {
      console.error("OpenSubtitles Search Response:", await searchResponse.text());
      throw new Error('OpenSubtitles API search failed');
    }

    const searchData = await searchResponse.json();
    
    if (searchData.data && searchData.data.length > 0) {
      let bestMatch = findBestSubtitleMatch(searchData.data, fileSize, duration);
      
      if (bestMatch) {
        const downloadResponse = await fetch(`https://api.opensubtitles.com/api/v1/download`, {
          method: 'POST',
          headers: {  
            'Api-Key': OPENSUBTITLES_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ file_id: bestMatch.attributes.files[0].file_id })
        });

        const downloadData = await downloadResponse.json();
        if (downloadData.link) {
          const subtitleContent = await fetch(downloadData.link);
          let text = await subtitleContent.text();
          
          if (downloadData.link.endsWith(".srt")) {
            text = convertSrtToVtt(text);
          }
          
          subtitleCache.set(cacheKey, text);
          return text;
        }
      }
    }
  } catch (error) {
    console.error('Subtitle search error:', error);
  }

  return null;
}

function findBestSubtitleMatch(subtitles, fileSize, duration) {
  if (!subtitles || subtitles.length === 0) return null;

  let bestMatch = null;
  let bestScore = -Infinity;

  for (const subtitle of subtitles) {
    let score = 0;

    if (subtitle.attributes.movie_hash_match) {
      score += 1000;
    }

    if (duration && subtitle.attributes.movie_time_ms) {
      const subtitleDuration = subtitle.attributes.movie_time_ms / 1000;
      const durationDiff = Math.abs(duration - subtitleDuration);
      
      if (durationDiff < 60) {
        score += 500;
      } else if (durationDiff < 300) {
        score += 200;
      } else if (durationDiff < 600) {
        score += 50;
      }
      
      if (durationDiff < 10) {
        score += 300;
      }
    }

    if (fileSize && subtitle.attributes.size) {
      const sizeDiff = Math.abs(fileSize - subtitle.attributes.size);
      const sizeRatio = Math.min(fileSize, subtitle.attributes.size) / Math.max(fileSize, subtitle.attributes.size);
      
      if (sizeRatio > 0.95) {
        score += 300;
      } else if (sizeRatio > 0.90) {
        score += 150;
      } else if (sizeRatio > 0.80) {
        score += 50;
      }
    }

    if (subtitle.attributes.download_count) {
      score += Math.log10(subtitle.attributes.download_count + 1) * 10;
    }

    if (subtitle.attributes.fps) {
      score += 20;
    }

    if (subtitle.attributes.format === 'srt') {
      score += 10;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = subtitle;
    }
  }

  console.log(`Best subtitle match score: ${bestScore}`);
  return bestMatch;
}

// --- Stream Route ---
app.get("/stream", async (req, res) => {
  try {
    const torrentUrl = req.query.torrent;
    if (!torrentUrl) return res.status(400).json({ error: "No torrent URL" });

    const torrent = await getTorrent(torrentUrl);
    const file = torrent.files.find(f =>
      /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(f.name)
    ) || torrent.files[0];

    if (!file) return res.status(404).json({ error: "No video file in torrent" });

    const range = req.headers.range;
    const fileSize = file.length;

    if (!range) {
      res.setHeader("Content-Type", "video/mp4");
      const stream = file.createReadStream();
      stream.on("error", () => {});
      res.on("close", () => stream.destroy());
      return stream.pipe(res);
    }

    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
      return res.end();
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
      "Cache-Control": "public, max-age=3600"
    });

    const stream = file.createReadStream({ start, end });
    stream.on("error", () => {});
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    console.error('Stream error:', error);
    res.status(500).json({ error: "Stream error" });
  }
});

// --- Enhanced Subtitles Route with Duration ---
app.get("/subs", async (req, res) => {
  try {
    const { torrent: torrentUrl, lang = "eng", imdbId, offset, duration } = req.query; 
    if (!torrentUrl) return res.status(400).json({ error: "No torrent URL" });

    const torrent = await getTorrent(torrentUrl);
    const file = torrent.files.find(f =>
      /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(f.name)
    ) || torrent.files[0];

    if (!file) return res.status(404).json({ error: "No video file" });

    const videoDuration = duration ? parseFloat(duration) : null;

    let subtitleContent = await searchSubtitles(
      file.name,
      file.length,
      imdbId,
      videoDuration,
      lang
    );

    if (subtitleContent) {
      const offsetSeconds = parseFloat(offset) || 0;
      subtitleContent = applyTimeOffset(subtitleContent, offsetSeconds);

      res.setHeader("Content-Type", "text/vtt");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(subtitleContent);
    }

    res.status(404).json({ error: "No subtitles found" });
  } catch (error) {
    console.error('Subtitles error:', error);
    res.status(500).json({ error: "Subtitles error" });
  }
});

app.get("/stream/status", async (req, res) => {
  const torrentUrl = req.query.torrent;
  const torrent = client.get(torrentUrl);

  if (!torrent) {
    return res.json({ status: "loading" });
  }

  const file = torrent.files.find(f => f.name.endsWith(".mp4") || f.name.endsWith(".mkv"));
  if (!file) {
    return res.json({ status: "no-file" });
  }

  return res.json({ status: "ready" });
});

// --- Available Subtitle Languages ---
app.get("/subs/languages", async (req, res) => {
  try {
    const englishLang = [{ code: "en", name: "English" }];
    res.json(englishLang);
  } catch (error) {
    res.status(500).json({ error: "Failed to get languages" });
  }
});

// --- Helpers ---
function applyTimeOffset(vttContent, offsetSeconds) {
    if (offsetSeconds === 0 || typeof vttContent !== 'string') return vttContent;

    const timeCodeRegex = /(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{1,2}:\d{2}\.\d{3})/g;

    function timeToSeconds(timeStr) {
        const parts = timeStr.split(/[:.]/).map(Number);
        
        let totalSeconds = 0;
        let ms = parts.pop() / 1000;
        
        if (parts.length === 2) {
            totalSeconds = parts[0] * 60 + parts[1];
        } else if (parts.length === 3) {
            totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        return totalSeconds + ms;
    }

    function secondsToTime(totalSeconds) {
        if (totalSeconds < 0) totalSeconds = 0;

        const ms = Math.floor((totalSeconds % 1) * 1000);
        const totalSecs = Math.floor(totalSeconds);
        
        const secs = totalSecs % 60;
        const mins = Math.floor((totalSecs / 60) % 60);
        const hours = Math.floor(totalSecs / 3600);

        const pad = (num, len = 2) => String(num).padStart(len, '0');

        if (hours > 0) {
            return `${pad(hours)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
        }
        return `${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
    }

    return vttContent.replace(timeCodeRegex, (match) => {
        const originalSeconds = timeToSeconds(match);
        const newSeconds = originalSeconds + offsetSeconds;
        return secondsToTime(newSeconds);
    });
}

function convertSrtToVtt(srt) {
  let vtt = "WEBVTT\n\n";

  vtt += srt
    .replace(/<[^>]*>/g, "")
    .replace(/{[^}]*}/g, "")
    .replace(/^\s*\d+\s*[\r\n]/gm, "") 
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .replace(/\r\n/g, "\n")
    .trim();

  return vtt;
}

app.get("/download", async (req, res) => {
  try {
    const { 
      torrent: torrentUrl, 
      quality, 
      title, 
      imdbId, 
      type = "video/mp4" 
    } = req.query;

    if (!torrentUrl) {
      return res.status(400).json({ error: "No torrent URL provided" });
    }

    console.log(`📥 Download request for: ${title} (${quality})`);
    
    // Validate and decode torrent URL
    let decodedTorrentUrl;
    try {
      decodedTorrentUrl = decodeURIComponent(torrentUrl);
      console.log(`🔗 Decoded torrent URL: ${decodedTorrentUrl.substring(0, 100)}...`);
    } catch (error) {
      console.log('⚠️ Torrent URL was not encoded, using as-is');
      decodedTorrentUrl = torrentUrl;
    }

    const torrent = await getTorrent(decodedTorrentUrl);
    
    const file = torrent.files.find(f =>
      /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(f.name)
    ) || torrent.files[0];

    if (!file) {
      return res.status(404).json({ error: "No video file found in torrent" });
    }

    const safeTitle = (title || file.name || 'download')
      .replace(/[^a-zA-Z0-9\s\-\.]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    const fileExtension = file.name.split('.').pop() || 'mp4';
    const filename = `${safeTitle} (${quality}).${fileExtension}`;

    // Set headers for download
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', file.length);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Accept-Ranges', 'bytes');

    console.log(`⬇️ Starting download: ${filename} (${file.length} bytes)`);

    // Handle range requests for resumable downloads
    const range = req.headers.range;
    if (range) {
      const fileSize = file.length;
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      
      if (start >= fileSize || end >= fileSize) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
        return res.end();
      }

      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': type,
        'Content-Disposition': `attachment; filename="${filename}"`
      });

      const stream = file.createReadStream({ start, end });
      stream.on("error", (error) => {
        console.error('Stream error during download:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Stream error during download" });
        }
      });
      
      res.on("close", () => {
        stream.destroy();
        console.log(`Download stream closed for: ${filename}`);
      });
      
      return stream.pipe(res);
    }

    // Full file download
    const stream = file.createReadStream();
    
    stream.on("error", (error) => {
      console.error('Stream error during download:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Stream error during download" });
      }
    });

    stream.on("end", () => {
      console.log(`✅ Download completed for: ${filename}`);
    });

    res.on("close", () => {
      stream.destroy();
      console.log(`Download interrupted for: ${filename}`);
    });

    stream.pipe(res);

  } catch (error) {
    console.error('❌ Download error:', error);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        error: "Download failed", 
        message: error instanceof Error ? error.message : "Unknown error",
        details: "Check if the torrent link is valid and accessible"
      });
    }
  }
});


client.on('error', (err) => {
  console.error('WebTorrent client error:', err);
});

app.get("/health", (req, res) => {
  const torrentInfo = client.torrents.map(t => ({
    name: t.name,
    progress: t.progress,
    ready: t.ready,
    numPeers: t.numPeers,
    downloadSpeed: t.downloadSpeed,
    uploadSpeed: t.uploadSpeed
  }));

  res.json({ 
    status: "healthy", 
    torrents: client.torrents.length,
    activeTorrents: torrentInfo,
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

const PORT = process.env.PORT || 3050;
app.listen(PORT, () => {
  console.log(`🚀 Production server running on port ${PORT}`);
  console.log(`📺 Live matches available at: http://localhost:${PORT}/live`);
});