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
  // ==== Utilities ====
  const hasFetchV2 = typeof fetchv2 === "function";
  async function httpGet(u, opts = {}) {
    try {
      if (hasFetchV2) {
        return await fetchv2(u, opts.headers || {}, opts.method || "GET", opts.body || null);
      } else {
        return await fetch(u, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body || null });
      }
    } catch {
      try {
        return await fetch(u, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body || null });
      } catch {
        return null;
      }
    }
  }

  function safeTrim(s) {
    return s ? String(s).trim() : "";
  }

  function normalizeUrl(raw, base = "") {
    if (!raw) return raw;
    raw = safeTrim(raw);
    if (raw.startsWith("//")) return "https:" + raw;
    if (raw.startsWith("/")) {
      if (!base) return "https://" + raw.replace(/^\/+/, "");
      return base.replace(/\/$/, "") + raw;
    }
    if (!/^https?:\/\//i.test(raw)) return "https://" + raw;
    return raw;
  }

  // ==== Extractors ====

  async function extractMp4upload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const page = await res.text();
    let m = page.match(/player\.src\(\{\s*(?:file|src)\s*:\s*['"]([^'"]+)['"]/i) || page.match(/file:\s*'([^']+)'/i) || page.match(/"file"\s*:\s*"([^"]+)"/i);
    if (m && m[1]) return normalizeUrl(m[1], embedUrl);
    m = page.match(/\/get_video\?id=([a-zA-Z0-9]+)/i);
    if (m && m[1]) {
      const trial = await httpGet(`https://www.mp4upload.com/get_video?id=${m[1]}`, { headers: { Referer: embedUrl } });
      if (trial) {
        const txt = await trial.text();
        try {
          const j = JSON.parse(txt);
          if (j && j.file) return normalizeUrl(j.file, embedUrl);
        } catch {}
      }
    }
    return null;
  }

  async function extractUqload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const headers = { Referer: embedUrl, Origin: "https://uqload.net", "User-Agent": "Mozilla/5.0" };
    const res = await httpGet(embedUrl, { headers });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/sources:\s*\[\s*"([^"]+\.mp4)"\s*\]/);
    if (match && match[1]) return normalizeUrl(match[1], embedUrl);
    return null;
  }

  async function extractYourupload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const headers = { Referer: "https://www.yourupload.com/", "User-Agent": "Mozilla/5.0" };
    const res = await httpGet(embedUrl, { headers });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/file:\s*['"]([^'"]+\.mp4)['"]/);
    if (match && match[1]) return normalizeUrl(match[1], embedUrl);
    return null;
  }

  async function extractDoodstream(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();

    // Try direct source
    let m = html.match(/file\s*:\s*['"]([^'"]+)['"]/i);
    if (!m) m = html.match(/"file"\s*:\s*"([^"]+)"/i);
    if (m && m[1]) return normalizeUrl(m[1], embedUrl);

    // Try unpack eval if present (you can add unpackEval func if needed)
    // Skipped here for brevity

    return null;
  }

  async function extractVoe(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const idMatch = embedUrl.match(/\/e\/([^/?#]+)/i);
    if (!idMatch) return null;
    const id = idMatch[1];
    const api = `https://voe.sx/api/source/${id}`;
    const res = await httpGet(api, {
      method: "POST",
      headers: {
        Referer: embedUrl,
        "User-Agent": "Mozilla/5.0",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (!res) return null;
    let json;
    try {
      json = await res.json();
    } catch {
      return null;
    }
    if (!json || !json.data) return null;
    if (Array.isArray(json.data)) {
      // prefer HLS if available
      const hls = json.data.find((s) => s.file && /\.m3u8/i.test(s.file));
      if (hls) return normalizeUrl(hls.file, embedUrl);
      if (json.data[0] && json.data[0].file) return normalizeUrl(json.data[0].file, embedUrl);
    }
    return null;
  }

  async function extractFilemoon(html, baseUrl) {
    // Simple logic: extract iframe src then extract master.m3u8 from eval packed script
    const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"[^>]*><\/iframe>/i);
    if (!iframeMatch) return null;
    const iframeUrl = normalizeUrl(iframeMatch[1], baseUrl);
    const res = await httpGet(iframeUrl, { headers: { Referer: baseUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const iframeHtml = await res.text();

    // Find eval packed script with master.m3u8 url
    const evalMatch = iframeHtml.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]+?\)\)/);
    if (!evalMatch) return null;

    // unpackEval function required - quick basic version:
    function unpackEval(packed) {
      try {
        // Using external unpacker libs or your own implementation needed here.
        // For demo, just return null
        return null;
      } catch {
        return null;
      }
    }
    const unpacked = unpackEval(evalMatch[0]);
    if (!unpacked) return null;

    const m3u8Match = unpacked.match(/https?:\/\/[^"']+master\.m3u8[^"']*/i);
    if (m3u8Match) return normalizeUrl(m3u8Match[0], iframeUrl);
    return null;
  }

  // ==== Main ====
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    // Extract links from <a data-ep-url="..." ...> and iframe src
    const anchorRe = /<a\b[^>]*\bdata-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const iframeRe = /<iframe[^>]+src=(?:(['"])(.*?)\1|([^\s>]+))/gi;

    const blockedKeywords = ["mega", "megamax", "dailymotion"];
    const providers = [];
    const seen = new Set();

    // Extract anchors
    let match;
    while ((match = anchorRe.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(match[2] || match[3] || "", url);
      let title = (match[4] || rawUrl).replace(/\s+/g, " ").trim();
      const titleLower = title.toLowerCase();
      const rawUrlLower = rawUrl.toLowerCase();

      if (seen.has(rawUrl)) continue;
      if (blockedKeywords.some((kw) => titleLower.includes(kw) || rawUrlLower.includes(kw))) continue;

      seen.add(rawUrl);
      providers.push({ rawUrl, title });
    }

    // Extract iframe if no anchors
    if (providers.length === 0) {
      let ifrMatch;
      while ((ifrMatch = iframeRe.exec(pageHtml)) !== null) {
        const rawUrl = normalizeUrl(ifrMatch[2] || ifrMatch[3] || "", url);
        const rawUrlLower = rawUrl.toLowerCase();
        if (blockedKeywords.some((kw) => rawUrlLower.includes(kw))) continue;
        providers.push({ rawUrl, title: "iframe" });
        break;
      }
    }

    if (providers.length === 0) return JSON.stringify({ streams: [] });

    const streams = [];
    for (const prov of providers) {
      const u = prov.rawUrl.toLowerCase();

      // Extra safety filter
      if (blockedKeywords.some((kw) => u.includes(kw))) continue;

      let direct = null;
      if (/mp4upload\.com/i.test(u)) {
        direct = await extractMp4upload(prov.rawUrl);
      } else if (/uqload/i.test(u)) {
        direct = await extractUqload(prov.rawUrl);
      } else if (/yourupload/i.test(u)) {
        direct = await extractYourupload(prov.rawUrl);
      } else if (/doodstream|d-s\.io|dood/i.test(u)) {
        direct = await extractDoodstream(prov.rawUrl);
      } else if (/voe\.sx|voe\//i.test(u)) {
        direct = await extractVoe(prov.rawUrl);
      } else if (/filemoon/i.test(u)) {
        direct = await extractFilemoon(pageHtml, url);
      }

      if (!direct) {
        try {
          const r = await httpGet(prov.rawUrl, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
          if (r) {
            const txt = await r.text();
            const found = txt.match(/https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*/i) || txt.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
            if (found && found[0]) direct = normalizeUrl(found[0], prov.rawUrl);
          }
        } catch {}
      }

      if (direct) {
        streams.push({
          title: prov.title,
          streamUrl: direct,
          headers: { Referer: prov.rawUrl, "User-Agent": "Mozilla/5.0" },
        });
      } else {
        streams.push({
          title: prov.title + " (embed)",
          streamUrl: prov.rawUrl,
          headers: { Referer: url, "User-Agent": "Mozilla/5.0" },
        });
      }
    }

    return JSON.stringify({ streams });
  } catch (e) {
    console.log("extractStreamUrl error:", e);
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
