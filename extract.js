const fetch = require('node-fetch');

// Supported sources
const SOURCES = {
  vidsrcpro: async (imdbId, type, season, episode) => {
    const base = type === 'tv'
      ? `https://vidsrc.pro/embed/tv/${imdbId}/${season}/${episode}`
      : `https://vidsrc.pro/embed/movie/${imdbId}`;
    return await extractVidsrcPro(base, imdbId, type, season, episode);
  },
  febbox: async (imdbId, type, season, episode) => {
    return await extractFebbox(imdbId, type, season, episode);
  },
  vidsrccc: async (imdbId, type, season, episode) => {
    const base = type === 'tv'
      ? `https://vidsrc.cc/v2/embed/tv/${imdbId}/${season}/${episode}`
      : `https://vidsrc.cc/v2/embed/movie/${imdbId}`;
    return await extractVidsrcCC(base);
  }
};

// ── VIDSRC.PRO EXTRACTOR ─────────────────────────────────
async function extractVidsrcPro(url, imdbId, type, season, episode) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://vidsrc.pro/'
      },
      timeout: 10000
    });
    const html = await res.text();

    // Extract src_id from page
    const srcMatch = html.match(/src_id\s*=\s*['"]([^'"]+)['"]/);
    if (!srcMatch) return null;
    const srcId = srcMatch[1];

    // Fetch sources list
    const apiUrl = `https://vidsrc.pro/api/source/${srcId}`;
    const apiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': url,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: 'r=https%3A%2F%2Fvidsrc.pro%2F&d=vidsrc.pro'
    });
    const apiJson = await apiRes.json();

    if (apiJson?.data?.length) {
      return apiJson.data.map(s => ({
        quality: s.label || 'HD',
        url: s.file,
        type: 'direct'
      }));
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ── FEBBOX EXTRACTOR ─────────────────────────────────────
async function extractFebbox(imdbId, type, season, episode) {
  try {
    const shareKey = await getFebboxShareKey(imdbId, type, season, episode);
    if (!shareKey) return null;

    const filesRes = await fetch(`https://www.febbox.com/file/file_share_list?share_key=${shareKey}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.febbox.com/'
      }
    });
    const filesJson = await filesRes.json();
    const files = filesJson?.data?.file_list;
    if (!files?.length) return null;

    const links = [];
    for (const f of files.slice(0, 4)) {
      try {
        const dlRes = await fetch(`https://www.febbox.com/file/player?fid=${f.fid}&share_key=${shareKey}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': `https://www.febbox.com/share/${shareKey}`
          }
        });
        const dlJson = await dlRes.json();
        if (dlJson?.data?.sources?.length) {
          links.push(...dlJson.data.sources.map(s => ({
            quality: s.label || f.file_name?.match(/\d{3,4}p/)?.[0] || 'HD',
            url: s.file,
            filename: f.file_name,
            type: 'direct'
          })));
        }
      } catch (_) {}
    }
    return links.length ? links : null;
  } catch (e) {
    return null;
  }
}

async function getFebboxShareKey(imdbId, type, season, episode) {
  try {
    const path = type === 'tv'
      ? `https://showtimes.fun/api/share?imdb_id=${imdbId}&tv=1&season=${season}&episode=${episode}`
      : `https://showtimes.fun/api/share?imdb_id=${imdbId}`;
    const res = await fetch(path, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://showtimes.fun/' }
    });
    const json = await res.json();
    return json?.link?.split('/').pop() || null;
  } catch (_) { return null; }
}

// ── VIDSRC.CC EXTRACTOR ──────────────────────────────────
async function extractVidsrcCC(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://vidsrc.cc/'
      }
    });
    const html = await res.text();
    // Find m3u8 or mp4 links
    const m3u8 = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/g);
    const mp4   = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/g);
    const links = [];
    if (mp4)  links.push(...mp4.map(u  => ({ quality: u.match(/\d{3,4}p/)?.[0]||'HD',  url: u, type: 'direct' })));
    if (m3u8) links.push(...m3u8.map(u => ({ quality: 'HLS', url: u, type: 'm3u8' })));
    return links.length ? links : null;
  } catch (e) { return null; }
}

// ── MAIN HANDLER ─────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { imdb, type = 'movie', season = '1', episode = '1', source = 'all' } = req.query;

  if (!imdb) {
    return res.status(400).json({ ok: false, error: 'imdb param required (e.g. ?imdb=tt1234567)' });
  }

  const results = {};
  const toTry = source === 'all'
    ? Object.keys(SOURCES)
    : [source].filter(s => SOURCES[s]);

  await Promise.all(toTry.map(async (src) => {
    try {
      const links = await SOURCES[src](imdb, type, season, episode);
      if (links?.length) results[src] = links;
    } catch (_) {}
  }));

  const allLinks = Object.entries(results).flatMap(([src, links]) =>
    links.map(l => ({ ...l, source: src }))
  );

  res.status(200).json({
    ok: true,
    imdb,
    type,
    season: type === 'tv' ? parseInt(season) : undefined,
    episode: type === 'tv' ? parseInt(episode) : undefined,
    count: allLinks.length,
    links: allLinks
  });
};
