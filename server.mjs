import express from "express";
import WebTorrent from "webtorrent";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import cors from "cors";
import NodeCache from "node-cache";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- WebTorrent Client ---
const client = new WebTorrent({
  maxConns: 20,
  tracker: true,
  dht: false,
  webSeeds: true,
  path: path.join(os.tmpdir(), "webtorrent", "tmp"),
});

// --- Caches ---
const torrentMap = new Map();
const subtitleCache = new NodeCache({ stdTTL: 86400 }); // 24 hours

// --- Environment Variables ---
const {
  OPENSUBTITLES_API_KEY = "RxPfsDLz24QZiE4A4WgwGE2XHcvz4Rng",
  NODE_ENV = "development",
  PORT = 3050,
} = process.env;

// --- Rate Limiting ---
const requestCounts = new Map();
const RATE_LIMIT = 200;
const RATE_LIMIT_WINDOW = 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;

  if (!requestCounts.has(ip)) requestCounts.set(ip, []);
  const requests = requestCounts.get(ip).filter((t) => t > windowStart);
  requests.push(now);
  requestCounts.set(ip, requests);

  if (requests.length > RATE_LIMIT) {
    return res.status(429).json({ error: "Too many requests" });
  }
  next();
}

app.use(rateLimit);

// --- Torrent Management ---
async function getTorrent(torrentUrl) {
  return new Promise((resolve, reject) => {
    const cacheKey = Buffer.from(torrentUrl).toString("base64");

    if (torrentMap.has(cacheKey)) {
      const cached = torrentMap.get(cacheKey);
      cached.lastAccessed = Date.now();
      return resolve(cached.torrent);
    }

    const torrent = client.add(torrentUrl, {
      path: path.join(os.tmpdir(), "webtorrent", Date.now().toString()),
    });

    const wrapper = { torrent, lastAccessed: Date.now() };
    torrentMap.set(cacheKey, wrapper);

    torrent.on("ready", () => resolve(torrent));
    torrent.on("error", (err) => {
      console.error("Torrent error:", err);
      torrentMap.delete(cacheKey);
      reject(err);
    });

    // Periodic cleanup
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
  });
}

// --- Subtitle Search ---
async function searchSubtitles(movieTitle, fileSize, imdbId, duration, lang = "eng") {
  const cacheKey = `subs_${imdbId}_${lang}_${fileSize}_${duration}`;
  const cached = subtitleCache.get(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      languages: lang,
      order_by: "download_count",
      order_direction: "desc",
    });

    if (imdbId) {
      params.append("imdb_id", imdbId.replace("tt", ""));
    } else {
      params.append("query", movieTitle);
    }

    const res = await fetch(`https://api.opensubtitles.com/api/v1/subtitles?${params}`, {
      headers: {
        "Api-Key": OPENSUBTITLES_API_KEY,
        "User-Agent": "StreamFlix v1.0",
      },
    });

    if (!res.ok) throw new Error("OpenSubtitles API failed");
    const data = await res.json();
    if (!data.data?.length) return null;

    const bestMatch = findBestSubtitleMatch(data.data, fileSize, duration);
    if (!bestMatch) return null;

    const dlRes = await fetch(`https://api.opensubtitles.com/api/v1/download`, {
      method: "POST",
      headers: {
        "Api-Key": OPENSUBTITLES_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file_id: bestMatch.attributes.files[0].file_id }),
    });

    const dlData = await dlRes.json();
    if (!dlData.link) return null;

    const text = await (await fetch(dlData.link)).text();
    const vttText = dlData.link.endsWith(".srt") ? convertSrtToVtt(text) : text;

    subtitleCache.set(cacheKey, vttText);
    return vttText;
  } catch (error) {
    console.error("Subtitle search error:", error);
    return null;
  }
}

function findBestSubtitleMatch(subtitles, fileSize, duration) {
  let best = null;
  let score = -Infinity;

  for (const s of subtitles) {
    let current = 0;

    if (s.attributes.movie_hash_match) current += 1000;

    if (duration && s.attributes.movie_time_ms) {
      const subDur = s.attributes.movie_time_ms / 1000;
      const diff = Math.abs(duration - subDur);
      if (diff < 60) current += 500;
      else if (diff < 300) current += 200;
      else if (diff < 600) current += 50;
    }

    if (fileSize && s.attributes.size) {
      const ratio =
        Math.min(fileSize, s.attributes.size) /
        Math.max(fileSize, s.attributes.size);
      if (ratio > 0.95) current += 300;
      else if (ratio > 0.9) current += 150;
      else if (ratio > 0.8) current += 50;
    }

    if (s.attributes.download_count)
      current += Math.log10(s.attributes.download_count + 1) * 10;
    if (s.attributes.fps) current += 20;
    if (s.attributes.format === "srt") current += 10;

    if (current > score) {
      score = current;
      best = s;
    }
  }

  return best;
}

// --- Helpers ---
function convertSrtToVtt(srt) {
  return (
    "WEBVTT\n\n" +
    srt
      .replace(/<[^>]*>/g, "")
      .replace(/{[^}]*}/g, "")
      .replace(/^\s*\d+\s*[\r\n]/gm, "")
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
      .replace(/\r\n/g, "\n")
      .trim()
  );
}

function applyTimeOffset(vtt, offsetSeconds) {
  if (!offsetSeconds) return vtt;

  const regex = /(\d{1,2}:\d{2}:\d{2}\.\d{3})/g;
  return vtt.replace(regex, (match) => {
    const parts = match.split(/[:.]/).map(Number);
    const total = parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / 1000;
    const newTime = Math.max(0, total + offsetSeconds);

    const h = String(Math.floor(newTime / 3600)).padStart(2, "0");
    const m = String(Math.floor((newTime % 3600) / 60)).padStart(2, "0");
    const s = String(Math.floor(newTime % 60)).padStart(2, "0");
    const ms = String(Math.floor((newTime % 1) * 1000)).padStart(3, "0");
    return `${h}:${m}:${s}.${ms}`;
  });
}

// --- Routes ---
app.get("/stream", async (req, res) => {
  try {
    const { torrent: torrentUrl } = req.query;
    if (!torrentUrl) return res.status(400).json({ error: "No torrent URL" });

    const torrent = await getTorrent(torrentUrl);
    const file =
      torrent.files.find((f) => /\.(mp4|mkv|avi|mov|webm)$/i.test(f.name)) ||
      torrent.files[0];
    if (!file) return res.status(404).json({ error: "No video file found" });

    const range = req.headers.range;
    const fileSize = file.length;

    if (!range) {
      res.setHeader("Content-Type", "video/mp4");
      return file.createReadStream().pipe(res);
    }

    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
    });

    file.createReadStream({ start, end }).pipe(res);
  } catch (err) {
    console.error("Stream error:", err);
    res.status(500).json({ error: "Stream failed" });
  }
});

app.get("/subs", async (req, res) => {
  try {
    const { torrent, lang = "eng", imdbId, offset, duration } = req.query;
    if (!torrent) return res.status(400).json({ error: "Missing torrent" });

    const t = await getTorrent(torrent);
    const f =
      t.files.find((f) => /\.(mp4|mkv|avi|mov|webm)$/i.test(f.name)) || t.files[0];
    if (!f) return res.status(404).json({ error: "No video file" });

    const sub = await searchSubtitles(
      f.name,
      f.length,
      imdbId,
      parseFloat(duration) || null,
      lang
    );
    if (!sub) return res.status(404).json({ error: "No subtitles found" });

    const adjusted = applyTimeOffset(sub, parseFloat(offset) || 0);
    res.setHeader("Content-Type", "text/vtt");
    res.send(adjusted);
  } catch (e) {
    console.error("Subtitles error:", e);
    res.status(500).json({ error: "Subtitle error" });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    torrents: client.torrents.length,
    memory: process.memoryUsage(),
    uptime: process.uptime(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Torrent Stream server running on port ${PORT} (${NODE_ENV})`);
});
