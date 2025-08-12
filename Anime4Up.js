async function searchResults(keyword) {
  try {
    const url = `https://4q.4ruhzd.shop/?search_param=animes&s=${encodeURIComponent(keyword)}`;
    const res = await fetchv2(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://4q.4ruhzd.shop/'
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

  async function mp4uploadExtractor(html, url) {
  // لازم نعطي url (صفحة embed) لاستخراج id الفيديو منها
  if (!url) {
    console.log("URL is required for mp4uploadExtractor");
    return null;
  }

  // 1. استخرج id الفيديو من الرابط أو من داخل html
  let id = null;

  // حاول استخراج id من الرابط نفسه إذا هو صفحة embed
  let idMatchFromUrl = url.match(/embed-([a-z0-9]+)/i);
  if (idMatchFromUrl) {
    id = idMatchFromUrl[1];
  } else {
    // أو من داخل الصفحة
    const idMatchFromHtml = html.match(/\/get_video\?id=([a-zA-Z0-9]+)/i);
    if (idMatchFromHtml) id = idMatchFromHtml[1];
  }

  if (!id) {
    console.log("Could not find video id for mp4upload");
    return null;
  }

  // 2. استدعي API للحصول على رابط الفيديو
  const apiUrl = `https://www.mp4upload.com/get_video?id=${id}`;
  try {
    const res = await fetch(apiUrl, {
      headers: {
        Referer: url,
        Origin: "https://www.mp4upload.com",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Accept: "application/json, text/javascript, */*; q=0.01",
      },
    });
    if (!res.ok) {
      console.log("Failed to fetch mp4upload video API");
      return null;
    }
    const json = await res.json();

    if (json && json.file) {
      return json.file; // رابط مباشر للفيديو
    } else {
      console.log("API response has no 'file' field");
      return null;
    }
  } catch (e) {
    console.log("Error fetching mp4upload API:", e);
    return null;
  }
}

  async function extractUqload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const headers = { Referer: embedUrl, Origin: "https://uqload.net", "User-Agent": "Mozilla/5.0" };
    const res = await httpGet(embedUrl, { headers });
    if (!res) return null;
    const html = await res.text();

    // جرب البحث عن sources بمصفوفة URLs
    let match = html.match(/sources:\s*\[\s*"(https?:[^"]+\.mp4)"\s*\]/i);
    if (match && match[1]) return normalizeUrl(match[1], embedUrl);

    // جرب البحث عن مصدر فيديو ضمن فيديو HTML
    match = html.match(/<video[^>]+src=['"]([^'"]+\.mp4)['"]/i);
    if (match && match[1]) return normalizeUrl(match[1], embedUrl);

    return null;
  }

  async function extractYourupload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const headers = { Referer: "https://www.yourupload.com/", "User-Agent": "Mozilla/5.0" };
    const res = await httpGet(embedUrl, { headers });
    if (!res) return null;
    const html = await res.text();

    let match = html.match(/file:\s*['"]([^'"]+\.mp4)['"]/i);
    if (match && match[1]) return normalizeUrl(match[1], embedUrl);

    match = html.match(/sources\s*:\s*(\[[^\]]+\])/i);
    if (match) {
      try {
        const sources = JSON.parse(match[1].replace(/'/g, '"'));
        if (sources.length) return normalizeUrl(sources[0].file, embedUrl);
      } catch {}
    }

    match = html.match(/<video[^>]+src=['"]([^'"]+\.mp4)['"]/i);
    if (match && match[1]) return normalizeUrl(match[1], embedUrl);

    return null;
  }

  async function extractDoodstream(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();

    let m = html.match(/file\s*:\s*['"]([^'"]+)['"]/i);
    if (!m) m = html.match(/"file"\s*:\s*"([^"]+)"/i);
    if (!m) m = html.match(/sources\s*:\s*\[\s*{\s*file\s*:\s*['"]([^'"]+)['"]/i);
    if (m && m[1]) return normalizeUrl(m[1], embedUrl);

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
      const hls = json.data.find((s) => s.file && /\.m3u8/i.test(s.file));
      if (hls) return normalizeUrl(hls.file, embedUrl);
      if (json.data[0] && json.data[0].file) return normalizeUrl(json.data[0].file, embedUrl);
    }
    return null;
  }

  async function extractFilemoon(html, baseUrl) {
    const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"[^>]*><\/iframe>/i);
    if (!iframeMatch) return null;
    const iframeUrl = normalizeUrl(iframeMatch[1], baseUrl);
    const res = await httpGet(iframeUrl, { headers: { Referer: baseUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const iframeHtml = await res.text();

    // بما أن unpackEval غير معرف هنا، نحاول البحث مباشرة عن رابط m3u8
    const m3u8Match = iframeHtml.match(/https?:\/\/[^"']+master\.m3u8[^"']*/i);
    if (m3u8Match) return normalizeUrl(m3u8Match[0], iframeUrl);
    return null;
  }

  // ==== Main ====
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const anchorRe = /<a\b[^>]*\bdata-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const iframeRe = /<iframe[^>]+src=(?:(['"])(.*?)\1|([^\s>]+))/gi;

    const blockedKeywords = ["mega", "megamax", "dailymotion"];
    const providers = [];
    const seen = new Set();

    let match;
    while ((match = anchorRe.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(match[2] || match[3] || "", url);
      const rawUrlLower = rawUrl.toLowerCase();

      if (seen.has(rawUrl)) continue;
      if (blockedKeywords.some((kw) => rawUrlLower.includes(kw))) continue;

      seen.add(rawUrl);
      let title = (match[4] || rawUrl).replace(/\s+/g, " ").trim();
      providers.push({ rawUrl, title });
    }

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
