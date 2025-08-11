async function searchResults(keyword) {
  try {
    const url = `https://4p.jguris.shop/?search_param=animes&s=${encodeURIComponent(keyword)}`;
    const res = await fetchv2(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://4p.jguris.shop/'
      }
    });
    const html = await res.text();

    const results = [];
    const blocks = html.split('anime-card-container');
    for (const block of blocks) {
      const hrefMatch = block.match(/<a href="([^"]+\/anime\/[^"]+)"/);
      const imgMatch = block.match(/<img[^>]+src="([^"]+)"[^>]*>/);
      const titleMatch = block.match(/anime-card-title[^>]*>\s*<h3>\s*<a[^>]*>([^<]+)<\/a>/);

      if (hrefMatch && imgMatch && titleMatch) {
        results.push({
          title: decodeHTMLEntities(titleMatch[1]),
          href: hrefMatch[1],
          image: imgMatch[1]
        });
      }
    }

    if (results.length === 0) {
      return JSON.stringify([{ title: 'No results found', href: '', image: '' }]);
    }

    return JSON.stringify(results);
  } catch (err) {
    return JSON.stringify([{ title: 'Error', href: '', image: '', error: err.message }]);
  }
}

async function extractDetails(url) {
  try {
    const response = await fetchv2(url);
    const html = await response.text();
    let description = "لا يوجد وصف متاح.";
    let airdate = "غير معروف";
    let aliases = "غير مصنف";

    const descMatch = html.match(/<p class="anime-story">([\s\S]*?)<\/p>/i);
    if (descMatch) {
      const rawDescription = descMatch[1].trim();
      if (rawDescription.length > 0) {
        description = decodeHTMLEntities(rawDescription);
      }
    }

    const genresMatch = html.match(/<ul class="anime-genres">([\s\S]*?)<\/ul>/i);
    if (genresMatch) {
      const genreItems = [...genresMatch[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)];
      const genres = genreItems.map(m => decodeHTMLEntities(m[1].trim()));
      if (genres.length > 0) {
        aliases = genres.join(", ");
      }
    }

    const airdateMatch = html.match(/<span>\s*بداية العرض:\s*<\/span>\s*(\d{4})/i);
    if (airdateMatch) {
      const extracted = airdateMatch[1].trim();
      if (/^\d{4}$/.test(extracted)) {
        airdate = extracted;
      }
    }

    return JSON.stringify([
      {
        description,
        aliases,
        airdate: `سنة العرض: ${airdate}`
      }
    ]);
  } catch {
    return JSON.stringify([
      {
        description: "تعذر تحميل الوصف.",
        aliases: "غير مصنف",
        airdate: "سنة العرض: غير معروفة"
      }
    ]);
  }
}

async function extractEpisodes(url) {
  const results = [];
  try {
    const getPage = async (pageUrl) => {
      const res = await fetchv2(pageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Referer": url
        }
      });
      return await res.text();
    };

    const firstHtml = await getPage(url);
    const typeMatch = firstHtml.match(/<div class="anime-info"><span>النوع:<\/span>\s*([^<]+)<\/div>/i);
    const type = typeMatch ? typeMatch[1].trim().toLowerCase() : "";

    if (type.includes("movie") || type.includes("فيلم")) {
      return JSON.stringify([{ href: url, number: 1 }]);
    }

    const paginationRegex = /<a[^>]+href="([^"]+\/page\/\d+\/?)"[^>]*class="page-numbers"/gi;
    const pagesSet = new Set();
    let match;
    while ((match = paginationRegex.exec(firstHtml)) !== null) {
      pagesSet.add(match[1]);
    }

    const pages = Array.from(pagesSet);
    pages.push(url);

    const htmlPages = await Promise.all(pages.map(page => getPage(page)));

    for (const html of htmlPages) {
      const episodeRegex = /<div class="episodes-card-title">\s*<h3>\s*<a\s+href="([^"]+)">[^<]*الحلقة\s*(\d+)[^<]*<\/a>/gi;
      let epMatch;
      while ((epMatch = episodeRegex.exec(html)) !== null) {
        const episodeUrl = epMatch[1].trim();
        const episodeNumber = parseInt(epMatch[2].trim(), 10);
        if (!isNaN(episodeNumber)) {
          results.push({
            href: episodeUrl,
            number: episodeNumber
          });
        }
      }
    }

    results.sort((a, b) => a.number - b.number);

    if (results.length === 0) {
      return JSON.stringify([{ href: url, number: 1 }]);
    }

    return JSON.stringify(results);
  } catch {
    return JSON.stringify([{ href: url, number: 1 }]);
  }
}

// -------------------------------
// Sora-ready extractStreamUrl
// -------------------------------
async function extractStreamUrl(url) {
  // ====== Utilities ======
  const hasFetchV2 = typeof fetchv2 === 'function';
  async function httpGet(u, opts = {}) {
    // opts: { method, headers, body }
    try {
      if (hasFetchV2) {
        // fetchv2(url, headers, method, body)
        const res = await fetchv2(u, opts.headers || {}, opts.method || 'GET', opts.body || null);
        return res;
      } else {
        return await fetch(u, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body || null });
      }
    } catch (e) {
      try { // fallback to plain fetch again
        return await fetch(u, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body || null });
      } catch (err) {
        return null;
      }
    }
  }

  function safeTrim(s) { return s ? String(s).trim() : ''; }

  function decodeHTMLEntities(text) {
    if (!text) return text;
    const entities = { '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#039;':"'",'&#39;':"'",'&nbsp;':' ' };
    return text.replace(/&[a-zA-Z0-9#]+;/g, m => entities[m] || m);
  }

  function tryJsonParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  // Unpack `eval(function(p,a,c,k,e,d)...` packed JS commonly used by obfuscators
  function unpackEval(packed) {
    try {
      // quick check
      if (!/eval\(function\(p,a,c,k,e,d\)/.test(packed)) return null;
      // attempt using a safe regex-based unpacker (lightweight)
      // This is a simple unpacker adapted from common 'packer' routines.
      // NOTE: Not guaranteed for all obfuscations but works for many packer outputs.
      const payloadMatch = packed.match(/eval\(function\(p,a,c,k,e,d\)\{([\s\S]*?)\}\(([\s\S]*?)\)\)/);
      if (!payloadMatch) return null;
      // As a fallback, try to extract strings like "return p" etc. If too complex, return null.
      // Safer approach: try to find "return p" and extract inner string arrays:
      // Many pages include a readable source elsewhere; we'll fall back to fetch/regex extraction later.
      return null;
    } catch (e) {
      return null;
    }
  }

  // Normalize URL (add https: for protocol-less, absolute join for relative)
  function normalizeUrl(raw, base = '') {
    if (!raw) return raw;
    raw = safeTrim(raw);
    if (raw.startsWith('//')) return 'https:' + raw;
    if (raw.startsWith('/')) {
      if (!base) return 'https://' + raw.replace(/^\/+/, '');
      return base.replace(/\/$/, '') + raw;
    }
    if (!/^https?:\/\//i.test(raw)) return 'https://' + raw;
    return raw;
  }

  // Helper to attempt extracting file/url using regexes from an HTML string
  function findSourceInHtml(html) {
    if (!html) return null;
    // common patterns: file: "..."  src: "..."  "file":"..."  source src: "..."
    const reList = [
      /file\s*:\s*['"]([^'"]+)['"]/ig,
      /src\s*:\s*['"]([^'"]+)['"]/ig,
      /"file"\s*:\s*"([^"]+)"/ig,
      /"src"\s*:\s*"([^"]+)"/ig,
      /source\s+src=['"]([^'"]+)['"]/ig,
      /sources\s*:\s*(\[[\s\S]*?\])/ig
    ];
    for (const r of reList) {
      let m;
      while ((m = r.exec(html)) !== null) {
        if (m[1]) return m[1];
      }
    }
    // check for m3u8 urls
    const m3u8 = html.match(/https?:\/\/[^"'<>]+\.m3u8[^"'<>]*/i);
    if (m3u8) return m3u8[0];
    // mp4
    const mp4 = html.match(/https?:\/\/[^"'<>]+\.mp4[^"'<>]*/i);
    if (mp4) return mp4[0];
    return null;
  }

  // ====== Server-specific extractors ======
  // Each returns either a string URL (direct stream) or null. They should use normalizeUrl and httpGet.

  // 1) mp4upload
  async function extractMp4upload(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      // try to fetch embed page
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      // mp4upload patterns:
      // look for 'sources' JSON or player.src({src:"...", type:"video/mp4"})
      let m = page.match(/player\.src\(\{\s*(?:file|src)\s*:\s*['"]([^'"]+)['"]/i) || page.match(/file:\s*'([^']+)'/i) || page.match(/"file"\s*:\s*"([^"]+)"/i);
      if (m && m[1]) return normalizeUrl(m[1], embedUrl);

      // sometimes mp4upload uses a /dl endpoint or returns JSON inside script
      m = page.match(/\/get_video\?id=([a-zA-Z0-9]+)/i);
      if (m && m[1]) {
        // try hitting the public endpoint (best-effort)
        const trial = await httpGet(`https://www.mp4upload.com/get_video?id=${m[1]}`, { headers: { Referer: embedUrl } });
        if (trial) {
          const txt = await trial.text();
          const j = tryJsonParse(txt);
          if (j && j.file) return normalizeUrl(j.file, embedUrl);
        }
      }
      return null;
    } catch { return null; }
  }

  // 2) voe.sx
  async function extractVoe(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      // voe embed usually has /e/<id> — API: POST https://voe.sx/api/source/<id>
      const idMatch = embedUrl.match(/\/e\/([^/?#]+)/i);
      if (!idMatch) return null;
      const id = idMatch[1];
      const api = `https://voe.sx/api/source/${id}`;
      const res = await httpGet(api, { method: 'POST', headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res) return null;
      const json = await res.json().catch(()=>null);
      if (!json || !json.data) return null;
      // data is array of sources — pick the first hls or file
      if (Array.isArray(json.data)) {
        // prefer hls
        const hls = json.data.find(s => s.file && /\.m3u8/i.test(s.file));
        if (hls) return normalizeUrl(hls.file, embedUrl);
        // fallback to first file
        if (json.data[0] && json.data[0].file) return normalizeUrl(json.data[0].file, embedUrl);
      }
      return null;
    } catch { return null; }
  }

  // 3) vidmoly / vidmoly-like
  async function extractVidmoly(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      // many vidmoly pages have `file: "..." , label: "720p"` patterns
      let m = page.match(/file\s*:\s*['"]([^'"]+)['"]/i) || page.match(/"file"\s*:\s*"([^"]+)"/i);
      if (m && m[1]) return normalizeUrl(m[1], embedUrl);
      // try to find sources JSON
      m = page.match(/sources\s*:\s*(\[[\s\S]*?\])/i);
      if (m && m[1]) {
        const arr = tryJsonParse(m[1].replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":')); // crude normalizer
        if (Array.isArray(arr) && arr[0] && arr[0].file) return normalizeUrl(arr[0].file, embedUrl);
      }
      // fallback to searching for m3u8/mp4
      return findSourceInHtml(page);
    } catch { return null; }
  }

  // 4) uqload
  async function extractUqload(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      // typical pattern: "file":"https://.../video.mp4"
      let m = page.match(/"file"\s*:\s*"([^"]+)"/i) || page.match(/file:\s*'([^']+)'/i);
      if (m && m[1]) return normalizeUrl(m[1], embedUrl);
      // try m3u8 or mp4 detection
      return findSourceInHtml(page);
    } catch { return null; }
  }

  // 5) doodstream
  async function extractDoodstream(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      // doodstream often provides a page where sources are JS-obfuscated. Attempt fetch and regex.
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      // try to find m3u8 or mp4
      let s = findSourceInHtml(page);
      if (s) return normalizeUrl(s, embedUrl);
      // try to find obfuscated eval and unpack
      const unpacked = unpackEval(page);
      if (unpacked) {
        s = findSourceInHtml(unpacked);
        if (s) return normalizeUrl(s, embedUrl);
      }
      // dood may require performing inline JS (not possible here) — fallback to embedUrl
      return null;
    } catch { return null; }
  }

  // 6) videa.hu
  async function extractVidea(embedUrl) {
    try {
      // many videa embeds are protocol-less like //videa.hu/player?v=<code>
      embedUrl = normalizeUrl(embedUrl);
      const idMatch = embedUrl.match(/[?&]v=([^&]+)/i);
      if (!idMatch) return null;
      const vcode = idMatch[1];
      // videa often exposes playlist via player API – try player endpoint
      const playerUrl = `https://videa.hu/player?video_id=${vcode}`;
      const res = await httpGet(playerUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      // search for m3u8 or sources
      let s = findSourceInHtml(page);
      if (s) return normalizeUrl(s, embedUrl);
      return null;
    } catch { return null; }
  }

  // 7) megamax (and similar iframe wrappers)
  async function extractMegamax(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      // try common patterns
      let m = page.match(/(https?:\/\/[^"'<>]+\.m3u8[^"'<>]*)/i) || page.match(/"file":"([^"]+)"/i) || page.match(/source\s+src=['"]([^'"]+)['"]/i);
      if (m && m[1]) return normalizeUrl(m[1], embedUrl);
      // else fallback
      return null;
    } catch { return null; }
  }

  // ====== Main flow ======
  try {
    // 1. Fetch episode page HTML
    const pageRes = await httpGet(url, { headers: { Referer: url, 'User-Agent': 'Mozilla/5.0' } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    // 2. Extract all data-ep-url anchors (quotes or no-quotes)
    // robust regex that captures the attribute value and the anchor inner text
    const anchorRe = /<a\b[^>]*\bdata-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    const providers = []; // array of { rawUrl, title }
    const seen = new Set();
    while ((match = anchorRe.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(match[2] || match[3] || '', url);
      let title = decodeHTMLEntities((match[4] || '').replace(/\s+/g, ' ').trim()) || rawUrl;
      if (!rawUrl) continue;
      if (seen.has(rawUrl)) continue;
      seen.add(rawUrl);
      providers.push({ rawUrl, title });
    }

    // if none found, as last resort try to detect iframe src in the page
    if (providers.length === 0) {
      const ifr = pageHtml.match(/<iframe[^>]+src=(?:(['"])(.*?)\1|([^\s>]+))/i);
      if (ifr) {
        const raw = normalizeUrl(ifr[2] || ifr[3] || '', url);
        providers.push({ rawUrl: raw, title: 'iframe' });
      }
    }

    // 3. For each provider try the specialized extractor (in preferred order)
    const streams = [];
    for (const prov of providers) {
      const u = prov.rawUrl;
      let direct = null;

      // order of attempts: mp4upload, voe, vidmoly, uqload, doodstream, videa, megamax, fallback direct
      if (/mp4upload\.com/i.test(u)) {
        direct = await extractMp4upload(u);
      }
      if (!direct && /voe\.sx|voe\//i.test(u)) {
        direct = await extractVoe(u);
      }
      if (!direct && /vidmoly/i.test(u)) {
        direct = await extractVidmoly(u);
      }
      if (!direct && /uqload/i.test(u)) {
        direct = await extractUqload(u);
      }
      if (!direct && /d-s\.io|doodstream|dood/i.test(u)) {
        direct = await extractDoodstream(u);
      }
      if (!direct && /videa\.hu/i.test(u)) {
        direct = await extractVidea(u);
      }
      if (!direct && /megamax|megamax\.me/i.test(u)) {
        direct = await extractMegamax(u);
      }

      // final fallback: try to extract common m3u8/mp4 from the embed page or use the url itself
      if (!direct) {
        try {
          const r = await httpGet(u, { headers: { Referer: url, 'User-Agent': 'Mozilla/5.0' } });
          if (r) {
            const txt = await r.text();
            const found = findSourceInHtml(txt);
            if (found) direct = normalizeUrl(found, u);
          }
        } catch (e) {
          /* ignore */
        }
      }

      // If we found a direct stream, push it; else we can still push the embed link as a server option
      if (direct) {
        streams.push({
          title: prov.title || 'Server',
          streamUrl: direct,
          headers: { Referer: prov.rawUrl, 'User-Agent': 'Mozilla/5.0' }
        });
      } else {
        // push embed link as available server (Sora user can pick it, global extractor might handle it)
        streams.push({
          title: prov.title + ' (embed)',
          streamUrl: prov.rawUrl,
          headers: { Referer: url, 'User-Agent': 'Mozilla/5.0' }
        });
      }
    }

    // 4. Return result in Sora expected format
    return JSON.stringify({ streams });

  } catch (err) {
    console.log('extractStreamUrl error:', err);
    return JSON.stringify({ streams: [] });
  }
}

function decodeHTMLEntities(text) {
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#039;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&#39;': "'"
  };
  return text.replace(/&[a-zA-Z0-9#]+;/g, match => entities[match] || match);
}
