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
        return await fetchv2(u, opts.headers || {}, opts.method || 'GET', opts.body || null);
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
      if (!packed || !/eval\(function\(p,a,c,k,e,d\)/.test(packed)) return null;
      // Lightweight attempt — many obfuscators won't be handled here; keep as fallback hook.
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
    const m3u8 = html.match(/https?:\/\/[^"'<>]+\.m3u8[^"'<>]*/i);
    if (m3u8) return m3u8[0];
    const mp4 = html.match(/https?:\/\/[^"'<>]+\.mp4[^"'<>]*/i);
    if (mp4) return mp4[0];
    return null;
  }

  // ===== per-server default headers =====
  const defaultUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36";
  function serverHeaders(host) {
    const map = {
      "mp4upload": { Referer: "https://www.mp4upload.com/", "User-Agent": defaultUA },
      "vidmoly":   { Referer: "https://vidmoly.to/", "User-Agent": defaultUA },
      "uqload":    { Referer: "https://uqload.cx/", "User-Agent": defaultUA },
      "voe":       { Referer: "https://voe.sx/", "User-Agent": defaultUA },
      "dood":      { Referer: "https://doodstream.com/", "User-Agent": defaultUA },
      "videa":     { Referer: "https://videa.hu/", "User-Agent": defaultUA },
      "vk":        { Referer: "https://vk.com/", "User-Agent": defaultUA },
      "dailymotion":{ Referer: "https://www.dailymotion.com/", "User-Agent": defaultUA }
    };
    return map[host] || { Referer: "", "User-Agent": defaultUA };
  }

  // ====== Server-specific extractors ======
  // Each returns either a string URL (direct stream) or null.

  // 1) mp4upload
  async function extractMp4upload(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: serverHeaders("mp4upload") });
      if (!res) return null;
      const page = await res.text();

      // common patterns
      let m = page.match(/player\.src\(\{\s*(?:file|src)\s*:\s*['"]([^'"]+)['"]/i)
           || page.match(/file:\s*'([^']+)'/i)
           || page.match(/"file"\s*:\s*"([^"]+)"/i);
      if (m && m[1]) return normalizeUrl(m[1], embedUrl);

      // try get_video endpoint
      m = page.match(/\/get_video\?id=([a-zA-Z0-9_-]+)/i);
      if (m && m[1]) {
        const trial = await httpGet(`https://www.mp4upload.com/get_video?id=${m[1]}`, { headers: serverHeaders("mp4upload") });
        if (trial) {
          const txt = await trial.text();
          const j = tryJsonParse(txt);
          if (j && j.file) return normalizeUrl(j.file, embedUrl);
        }
      }

      // fallback: search for m3u8/mp4 in page
      const found = findSourceInHtml(page);
      return found ? normalizeUrl(found, embedUrl) : null;
    } catch { return null; }
  }

  // 2) voe.sx
  async function extractVoe(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const idMatch = embedUrl.match(/\/e\/([^/?#]+)/i);
      if (!idMatch) return null;
      const id = idMatch[1];
      const api = `https://voe.sx/api/source/${id}`;
      const res = await httpGet(api, { method: 'POST', headers: serverHeaders("voe"), body: '' });
      if (!res) return null;
      const json = await res.json().catch(()=>null);
      if (!json || !json.data) return null;
      if (Array.isArray(json.data)) {
        const hls = json.data.find(s => s.file && /\.m3u8/i.test(s.file));
        if (hls) return normalizeUrl(hls.file, embedUrl);
        if (json.data[0] && json.data[0].file) return normalizeUrl(json.data[0].file, embedUrl);
      }
      return null;
    } catch { return null; }
  }

  // 3) vidmoly (uses the extractor you provided)
  async function extractVidmoly(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: serverHeaders("vidmoly") });
      if (!res) return null;
      const page = await res.text();

      // check for base64 option pattern like in your snippet
      const regexSub = /<option value="([^"]+)"[^>]*>\s*SUB - Omega\s*<\/option>/i;
      const regexFallback = /<option value="([^"]+)"[^>]*>\s*Omega\s*<\/option>/i;
      const regexSubV2 = /<option value="([^"]+)"[^>]*>\s*SUB v2 - Omega\s*<\/option>/i;
      const match = page.match(regexSub) || page.match(regexFallback) || page.match(regexSubV2);

      if (match && match[1]) {
        // decode base64 -> get iframe -> fetch iframe page -> find m3u8
        try {
          const decoded = atob(match[1]);
          const iframeMatch = decoded.match(/<iframe\s+src="([^"]+)"/i);
          if (!iframeMatch) return null;
          let iframeUrl = iframeMatch[1];
          if (iframeUrl.startsWith("//")) iframeUrl = "https:" + iframeUrl;
          iframeUrl = normalizeUrl(iframeUrl, embedUrl);

          const res2 = await httpGet(iframeUrl, { headers: serverHeaders("vidmoly") });
          if (!res2) return null;
          const iframeHtml = await res2.text();

          const m3u8Match = iframeHtml.match(/sources:\s*\[\{file:\s*["']([^"']+\.m3u8)["']/i)
                         || iframeHtml.match(/"file"\s*:\s*"([^"]+\.m3u8)"/i);
          if (m3u8Match && m3u8Match[1]) return normalizeUrl(m3u8Match[1], iframeUrl);

          // fallback: search iframe HTML for m3u8 or mp4
          const found = findSourceInHtml(iframeHtml);
          if (found) return normalizeUrl(found, iframeUrl);
          return null;
        } catch (e) {
          return null;
        }
      } else {
        // fallback: look for sources in the main page
        const sourcesRegex = /sources:\s*\[\{file:\s*["'](https?:\/\/[^"']+)["']/i;
        const sm = page.match(sourcesRegex);
        if (sm && sm[1]) return normalizeUrl(sm[1], embedUrl);
        // last resort: try to find any m3u8/mp4
        const found = findSourceInHtml(page);
        return found ? normalizeUrl(found, embedUrl) : null;
      }
    } catch { return null; }
  }

  // 4) uqload
  async function extractUqload(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: serverHeaders("uqload") });
      if (!res) return null;
      const page = await res.text();

      let m = page.match(/"file"\s*:\s*"([^"]+)"/i) || page.match(/file:\s*'([^']+)'/i);
      if (m && m[1]) return normalizeUrl(m[1], embedUrl);

      const found = findSourceInHtml(page);
      return found ? normalizeUrl(found, embedUrl) : null;
    } catch { return null; }
  }

  // 5) doodstream
  async function extractDoodstream(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: serverHeaders("dood") });
      if (!res) return null;
      const page = await res.text();

      // try common patterns
      let s = findSourceInHtml(page);
      if (s) return normalizeUrl(s, embedUrl);

      // try to find obfuscated eval and attempt unpack (best-effort)
      const unpacked = unpackEval(page);
      if (unpacked) {
        s = findSourceInHtml(unpacked);
        if (s) return normalizeUrl(s, embedUrl);
      }

      return null;
    } catch { return null; }
  }

  // 6) videa.hu
  async function extractVidea(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const idMatch = embedUrl.match(/[?&]v=([^&]+)/i);
      if (!idMatch) return null;
      const vcode = idMatch[1];
      const playerUrl = `https://videa.hu/player?video_id=${vcode}`;
      const res = await httpGet(playerUrl, { headers: serverHeaders("videa") });
      if (!res) return null;
      const page = await res.text();
      const found = findSourceInHtml(page);
      return found ? normalizeUrl(found, embedUrl) : null;
    } catch { return null; }
  }

  // 7) VK (vkvideo.ru / vk.com embeds)
  async function extractVK(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: serverHeaders("vk") });
      if (!res) return null;
      const page = await res.text();

      // try patterns like "url720":"https:\/\/..."
      let m = page.match(/"url720"\s*:\s*"([^"]+)"/i) || page.match(/"url480"\s*:\s*"([^"]+)"/i) || page.match(/"url240"\s*:\s*"([^"]+)"/i);
      if (m && m[1]) return normalizeUrl(m[1].replace(/\\\//g, "/"), embedUrl);

      // try to find m3u8 or mp4 in the page
      const found = findSourceInHtml(page);
      return found ? normalizeUrl(found, embedUrl) : null;
    } catch { return null; }
  }

  // 8) Dailymotion (best-effort)
  async function extractDailymotion(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      // try to fetch page and find m3u8
      const res = await httpGet(embedUrl, { headers: serverHeaders("dailymotion") });
      if (!res) return null;
      const page = await res.text();

      // look for qualities JSON or m3u8 in page
      let m = page.match(/"qualities"\s*:\s*\{([\s\S]*?)\}\s*,\s*"metadata"/i);
      if (m && m[1]) {
        // try to find an m3u8 inside the qualities block
        const hls = m[1].match(/"auto"\s*:\s*\[\s*\{\s*"type"\s*:\s*"application\/x-mpegURL"\s*,\s*"url"\s*:\s*"([^"]+)"/i);
        if (hls && hls[1]) return normalizeUrl(hls[1], embedUrl);
      }

      // fallback: search for m3u8 anywhere
      const found = findSourceInHtml(page);
      return found ? normalizeUrl(found, embedUrl) : null;
    } catch { return null; }
  }

  // ====== Main flow ======
  try {
    // 1. Fetch episode page HTML
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": defaultUA } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    // 2. Extract all data-ep-url anchors (quotes or no-quotes)
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

      // order of attempts: mp4upload, voe, vidmoly, uqload, doodstream, videa, vk, dailymotion, fallback direct
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
      if (!direct && /vk(?:video|\.com)/i.test(u)) {
        direct = await extractVK(u);
      }
      if (!direct && /dailymotion/i.test(u)) {
        direct = await extractDailymotion(u);
      }

      // final fallback: try to extract common m3u8/mp4 from the embed page or use the url itself
      if (!direct) {
        try {
          const r = await httpGet(u, { headers: { Referer: url, "User-Agent": defaultUA } });
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
        // choose headers per host pattern for best compatibility
        let hostKey = "direct";
        if (/mp4upload/i.test(u)) hostKey = "mp4upload";
        else if (/vidmoly/i.test(u)) hostKey = "vidmoly";
        else if (/uqload/i.test(u)) hostKey = "uqload";
        else if (/voe/i.test(u)) hostKey = "voe";
        else if (/dood|d-s\.io/i.test(u)) hostKey = "dood";
        else if (/videa\.hu/i.test(u)) hostKey = "videa";
        else if (/vk(?:video|\.com)/i.test(u)) hostKey = "vk";
        else if (/dailymotion/i.test(u)) hostKey = "dailymotion";

        streams.push({
          title: prov.title || 'Server',
          streamUrl: direct,
          headers: serverHeaders(hostKey)
        });
      } else {
        streams.push({
          title: prov.title + ' (embed)',
          streamUrl: prov.rawUrl,
          headers: { Referer: url, "User-Agent": defaultUA }
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
