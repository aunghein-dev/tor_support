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

// --- Torrent Management ---
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
      // Enhanced matching algorithm with duration consideration
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

// --- Enhanced Subtitle Matching Algorithm ---
function findBestSubtitleMatch(subtitles, fileSize, duration) {
  if (!subtitles || subtitles.length === 0) return null;

  let bestMatch = null;
  let bestScore = -Infinity;

  for (const subtitle of subtitles) {
    let score = 0;

    // 1. Hash match (highest priority)
    if (subtitle.attributes.movie_hash_match) {
      score += 1000;
    }

    // 2. Duration matching (new - very important)
    if (duration && subtitle.attributes.movie_time_ms) {
      const subtitleDuration = subtitle.attributes.movie_time_ms / 1000; // Convert to seconds
      const durationDiff = Math.abs(duration - subtitleDuration);
      
      // Higher score for closer duration matches
      if (durationDiff < 60) { // Within 1 minute
        score += 500;
      } else if (durationDiff < 300) { // Within 5 minutes
        score += 200;
      } else if (durationDiff < 600) { // Within 10 minutes
        score += 50;
      }
      
      // Bonus for exact duration match
      if (durationDiff < 10) {
        score += 300;
      }
    }

    // 3. File size matching
    if (fileSize && subtitle.attributes.size) {
      const sizeDiff = Math.abs(fileSize - subtitle.attributes.size);
      const sizeRatio = Math.min(fileSize, subtitle.attributes.size) / Math.max(fileSize, subtitle.attributes.size);
      
      if (sizeRatio > 0.95) { // Within 5% size difference
        score += 300;
      } else if (sizeRatio > 0.90) { // Within 10% size difference
        score += 150;
      } else if (sizeRatio > 0.80) { // Within 20% size difference
        score += 50;
      }
    }

    // 4. Download count (popularity)
    if (subtitle.attributes.download_count) {
      score += Math.log10(subtitle.attributes.download_count + 1) * 10;
    }

    // 5. Frame rate matching
    if (subtitle.attributes.fps) {
      score += 20; // Bonus for having FPS info
    }

    // 6. Format preferences
    if (subtitle.attributes.format === 'srt') {
      score += 10; // Prefer SRT format
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

    // Parse duration to number
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
      
      // Apply time offset
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

// Time Offset Helper
function applyTimeOffset(vttContent, offsetSeconds) {
    if (offsetSeconds === 0 || typeof vttContent !== 'string') return vttContent;

    const timeCodeRegex = /(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{1,2}:\d{2}\.\d{3})/g;

    function timeToSeconds(timeStr) {
        const parts = timeStr.split(/[:.]/).map(Number);
        
        let totalSeconds = 0;
        let ms = parts.pop() / 1000;
        
        if (parts.length === 2) { // MM:SS
            totalSeconds = parts[0] * 60 + parts[1];
        } else if (parts.length === 3) { // HH:MM:SS
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

// VTT Conversion Helper
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

// --- Health Check ---
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    torrents: client.torrents.length,
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

const PORT = process.env.PORT || 3050;
app.listen(PORT, () => {
  console.log(`🚀 Production server running on port ${PORT}`);
});


