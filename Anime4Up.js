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
    try {
      if (hasFetchV2) {
        const res = await fetchv2(u, opts.headers || {}, opts.method || 'GET', opts.body || null);
        return res;
      } else {
        return await fetch(u, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body || null });
      }
    } catch (e) {
      try {
        return await fetch(u, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body || null });
      } catch {
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

  function unpackEval(packed) {
    try {
      if (!/eval\(function\(p,a,c,k,e,d\)/.test(packed)) return null;
      const payloadMatch = packed.match(/eval\(function\(p,a,c,k,e,d\)\{([\s\S]*?)\}\(([\s\S]*?)\)\)/);
      if (!payloadMatch) return null;
      return null;
    } catch {
      return null;
    }
  }

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

  // ====== Server-specific extractors ======
  async function extractMp4upload(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      let m = page.match(/player\.src\(\{\s*(?:file|src)\s*:\s*['"]([^'"]+)['"]/i) || page.match(/file:\s*'([^']+)'/i) || page.match(/"file"\s*:\s*"([^"]+)"/i);
      if (m && m[1]) return normalizeUrl(m[1], embedUrl);
      m = page.match(/\/get_video\?id=([a-zA-Z0-9]+)/i);
      if (m && m[1]) {
        const trial = await httpGet(`https://www.mp4upload.com/get_video?id=${m[1]}`, { headers: { Referer: embedUrl } });
        if (trial) {
          const txt = await trial.text();
          const j = tryJsonParse(txt);
          if (j && j.file) return normalizeUrl(j.file, embedUrl);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async function extractVoe(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const idMatch = embedUrl.match(/\/e\/([^/?#]+)/i);
      if (!idMatch) return null;
      const id = idMatch[1];
      const api = `https://voe.sx/api/source/${id}`;
      const res = await httpGet(api, { method: 'POST', headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res) return null;
      const json = await res.json().catch(() => null);
      if (!json || !json.data) return null;
      if (Array.isArray(json.data)) {
        const hls = json.data.find(s => s.file && /\.m3u8/i.test(s.file));
        if (hls) return normalizeUrl(hls.file, embedUrl);
        if (json.data[0] && json.data[0].file) return normalizeUrl(json.data[0].file, embedUrl);
      }
      return null;
    } catch {
      return null;
    }
  }

  async function extractVidmoly(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      let m = page.match(/file\s*:\s*['"]([^'"]+)['"]/i) || page.match(/"file"\s*:\s*"([^"]+)"/i);
      if (m && m[1]) return normalizeUrl(m[1], embedUrl);
      m = page.match(/sources\s*:\s*(\[[\s\S]*?\])/i);
      if (m && m[1]) {
        const arr = tryJsonParse(m[1].replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":'));
        if (Array.isArray(arr) && arr[0] && arr[0].file) return normalizeUrl(arr[0].file, embedUrl);
      }
      return findSourceInHtml(page);
    } catch {
      return null;
    }
  }

  async function extractUqload(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      let m = page.match(/"file"\s*:\s*"([^"]+)"/i) || page.match(/file:\s*'([^']+)'/i);
      if (m && m[1]) return normalizeUrl(m[1], embedUrl);
      return findSourceInHtml(page);
    } catch {
      return null;
    }
  }

  async function extractDoodstream(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      let s = findSourceInHtml(page);
      if (s) return normalizeUrl(s, embedUrl);
      const unpacked = unpackEval(page);
      if (unpacked) {
        s = findSourceInHtml(unpacked);
        if (s) return normalizeUrl(s, embedUrl);
      }
      return null;
    } catch {
      return null;
    }
  }

  async function extractVidea(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const idMatch = embedUrl.match(/[?&]v=([^&]+)/i);
      if (!idMatch) return null;
      const vcode = idMatch[1];
      const playerUrl = `https://videa.hu/player?video_id=${vcode}`;
      const res = await httpGet(playerUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      let s = findSourceInHtml(page);
      if (s) return normalizeUrl(s, embedUrl);
      return null;
    } catch {
      return null;
    }
  }

  async function extractMegamax(embedUrl) {
    try {
      embedUrl = normalizeUrl(embedUrl);
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, 'User-Agent': 'Mozilla/5.0' } });
      if (!res) return null;
      const page = await res.text();
      let m = page.match(/(https?:\/\/[^"'<>]+\.m3u8[^"'<>]*)/i) || page.match(/"file":"([^"]+)"/i) || page.match(/source\s+src=['"]([^'"]+)['"]/i);
      if (m && m[1]) return normalizeUrl(m[1], embedUrl);
      return null;
    } catch {
      return null;
    }
  }

  // ====== Main flow ======
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, 'User-Agent': 'Mozilla/5.0' } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const anchorRe = /<a\b[^>]*\bdata-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    const providers = [];
    const seen = new Set();
    while ((match = anchorRe.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(match[2] || match[3] || '', url);
      let title = decodeHTMLEntities((match[4] || '').replace(/\s+/g, ' ').trim()) || rawUrl;
      if (!rawUrl) continue;
      if (seen.has(rawUrl)) continue;

      // استبعاد روابط وسيرفرات ميجا وميجاماكس وديالي موشن
      const titleLower = title.toLowerCase();
      const rawUrlLower = rawUrl.toLowerCase();

      if (
        titleLower.includes('ميجا') ||
        titleLower.includes('ميجا ماكس') ||
        titleLower.includes('ديالي موشن') ||
        rawUrlLower.includes('mega') ||
        rawUrlLower.includes('megamax') ||
        rawUrlLower.includes('dailymotion')
      ) {
        continue; // تجاهلها تماماً
      }

      seen.add(rawUrl);
      providers.push({ rawUrl, title });
    }

    if (providers.length === 0) {
      const ifr = pageHtml.match(/<iframe[^>]+src=(?:(['"])(.*?)\1|([^\s>]+))/i);
      if (ifr) {
        const raw = normalizeUrl(ifr[2] || ifr[3] || '', url);
        const rawLower = raw.toLowerCase();
        if (
          !rawLower.includes('mega') &&
          !rawLower.includes('megamax') &&
          !rawLower.includes('dailymotion')
        ) {
          providers.push({ rawUrl: raw, title: 'iframe' });
        }
      }
    }

    const streams = [];
    for (const prov of providers) {
      const u = prov.rawUrl;

      // استبعاد نهائي إذا وصل هنا أي سيرفر محظور (احتياط)
      const titleLower = (prov.title || '').toLowerCase();
      const uLower = u.toLowerCase();
      if (
        titleLower.includes('ميجا') ||
        titleLower.includes('ميجا ماكس') ||
        titleLower.includes('ديالي موشن') ||
        uLower.includes('mega') ||
        uLower.includes('megamax') ||
        uLower.includes('dailymotion')
      ) {
        continue;
      }

      let direct = null;

      // لا تحاول استدعاء أي extractor خاص بـ Mega أو Dailymotion هنا (تم حذفهم تمامًا)
      if (/mp4upload\.com/i.test(u)) {
        direct = await extractMp4upload(u);
      }
      else if (/voe\.sx|voe\//i.test(u)) {
        direct = await extractVoe(u);
      }
      else if (/vidmoly/i.test(u)) {
        direct = await extractVidmoly(u);
      }
      else if (/uqload/i.test(u)) {
        direct = await extractUqload(u);
      }
      else if (/d-s\.io|doodstream|dood/i.test(u)) {
        direct = await extractDoodstream(u);
      }
      else if (/videa\.hu/i.test(u)) {
        direct = await extractVidea(u);
      }
      else if (/megamax|megamax\.me/i.test(u)) {
        direct = await extractMegamax(u);
      }

      if (!direct) {
        try {
          const r = await httpGet(u, { headers: { Referer: url, 'User-Agent': 'Mozilla/5.0' } });
          if (r) {
            const txt = await r.text();
            const found = findSourceInHtml(txt);
            if (found) direct = normalizeUrl(found, u);
          }
        } catch {}
      }

      if (direct) {
        streams.push({
          title: prov.title || 'Server',
          streamUrl: direct,
          headers: { Referer: prov.rawUrl, 'User-Agent': 'Mozilla/5.0' }
        });
      } else {
        streams.push({
          title: prov.title + ' (embed)',
          streamUrl: prov.rawUrl,
          headers: { Referer: url, 'User-Agent': 'Mozilla/5.0' }
        });
      }
    }

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
