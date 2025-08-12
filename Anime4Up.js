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
  async function httpGet(u, opts = {}) {
    try {
      return await fetch(u, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body || null });
    } catch {
      return null;
    }
  }

  function normalizeUrl(raw, base = "") {
    if (!raw) return raw;
    raw = String(raw).trim();
    if (raw.startsWith("//")) return "https:" + raw;
    try {
      if (base) return new URL(raw, base).href;
      if (raw.startsWith("/")) return "https://" + raw.replace(/^\/+/, "");
      if (/^[a-z0-9_\-\.]+\//i.test(raw)) return "https://" + raw;
      if (/^https?:\/\//i.test(raw)) return raw;
      return "https://" + raw;
    } catch {
      return /^https?:\/\//i.test(raw) ? raw : "https://" + raw.replace(/^\/+/, "");
    }
  }

  async function checkServer(serverUrl) {
    try {
      const resp = await httpGet(serverUrl, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } });
      if (resp && resp.status >= 200 && resp.status < 400) return true;
      return false;
    } catch {
      return false;
    }
  }

  function safeAtob(s) {
    if (typeof atob === "function") return atob(s);
    try {
      return Buffer.from(s, "base64").toString("utf-8");
    } catch {
      return "";
    }
  }

  function unpackEval(packed) {
    if (!packed || typeof packed !== "string") return null;
    const pAcker = /eval\(function\(p,a,c,k,e,(?:r|d)\)\s*\{([\s\S]+?)\}\)\)/;
    if (!pAcker.test(packed)) return null;

    try {
      let cleaned = packed
        .replace(/\\x([0-9A-Fa-f]{2})/g, (_, g) => String.fromCharCode(parseInt(g, 16)))
        .replace(/\\u0?([0-9A-Fa-f]{4})/g, (_, g) => String.fromCharCode(parseInt(g, 16)))
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\//g, "/");

      const b64Matches = cleaned.match(/([A-Za-z0-9\-_]{20,}={0,2})/g) || [];
      for (const b of b64Matches) {
        try {
          const dec = safeAtob(b);
          if (dec && /https?:\/\//.test(dec)) cleaned += "\n" + dec;
        } catch {}
      }
      return cleaned;
    } catch {
      return null;
    }
  }

  async function extractMp4upload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    if (html.includes("video you are looking for is not found")) return null;

    const evalMatch = html.match(/eval\(function\(p,a,c,k,e,(?:r|d)\)\{[\s\S]+?\}\)\([^\)]*\)/i);
    if (evalMatch) {
      const unpacked = unpackEval(evalMatch[0]);
      if (unpacked) {
        const found = unpacked.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
        if (found) return normalizeUrl(found[0], embedUrl);
      }
    }

    const match = html.match(/player\.src\(\{\s*(?:file|src)\s*:\s*["']([^"']+)["']/i) || html.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
    return match ? normalizeUrl(match[1] || match[0], embedUrl) : null;
  }

  async function extractUqload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const headers = { Referer: embedUrl, Origin: "https://uqload.net", "User-Agent": "Mozilla/5.0" };
    const res = await httpGet(embedUrl, { headers });
    if (!res) return null;
    const html = await res.text();

    const evalMatch = html.match(/eval\(function\(p,a,c,k,e,(?:r|d)\)\{[\s\S]+?\}\)\([^\)]*\)/i);
    if (evalMatch) {
      const unpacked = unpackEval(evalMatch[0]);
      if (unpacked) {
        const found = unpacked.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
        if (found) return normalizeUrl(found[0], embedUrl);
      }
    }

    const match = html.match(/sources:\s*\[\s*["']([^"']+\.mp4[^"']*)["']\s*\]/i) || html.match(/sources\s*=\s*\[["']([^"']+\.mp4[^"']*)["']\]/i) || html.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
    return match ? normalizeUrl(match[1] || match[0], embedUrl) : null;
  }

  async function extractDoodstream(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();

    const evalMatch = html.match(/eval\(function\(p,a,c,k,e,(?:r|d)\)\{[\s\S]+?\}\)\([^\)]*\)/i);
    if (evalMatch) {
      const unpacked = unpackEval(evalMatch[0]);
      if (unpacked) {
        const found = unpacked.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
        if (found) return normalizeUrl(found[0], embedUrl);
      }
    }

    const md5PathMatch = html.match(/\/pass_md5\/([a-zA-Z0-9\/\-_\.]+)['"]/i) || html.match(/pass_md5=([a-zA-Z0-9\/\-_\.]+)/i);
    if (!md5PathMatch) {
      const found = html.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
      return found ? normalizeUrl(found[0], embedUrl) : null;
    }
    const md5Path = md5PathMatch[1].replace(/['"]/g, "");
    const streamDomain = embedUrl.match(/^https?:\/\/([^\/]+)/i)?.[1];
    if (!streamDomain) return null;
    const token = md5Path.substring(md5Path.lastIndexOf("/") + 1);
    const expiryTimestamp = new Date().valueOf();
    const random = randomStr(10);
    const passResponse = await httpGet(`https://${streamDomain}/pass_md5/${md5Path}`, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!passResponse) {
      const f2 = html.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
      return f2 ? normalizeUrl(f2[0], embedUrl) : null;
    }
    const videoUrl = (await passResponse.text()).trim();
    return normalizeUrl(
      /^https?:\/\//i.test(videoUrl)
        ? `${videoUrl}${videoUrl.includes("?") ? "&" : "?"}token=${token}&expiry=${expiryTimestamp}`
        : `${videoUrl}${random}?token=${token}&expiry=${expiryTimestamp}`,
      embedUrl
    );
  }

  function randomStr(length) {
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }

  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await res.text();

    const anchorRe = /<a\b[^>]*\bdata-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const providers = [];
    const seen = new Set();
    const blockedKeywords = ["mega", "megamax", "dailymotion"];

    let match;
    while ((match = anchorRe.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(match[2] || match[3] || "", url);
      let title = (match[4] || rawUrl).replace(/\s+/g, " ").trim();
      const titleLower = title.toLowerCase();
      const rawUrlLower = rawUrl.toLowerCase();

      if (seen.has(rawUrl) || blockedKeywords.some((kw) => titleLower.includes(kw) || rawUrlLower.includes(kw))) continue;
      seen.add(rawUrl);
      providers.push({ rawUrl, title });
    }

    const streams = [];
    for (const prov of providers) {
      const u = prov.rawUrl.toLowerCase();
      if (blockedKeywords.some((kw) => u.includes(kw)) || !(await checkServer(prov.rawUrl))) continue;

      let direct = null;
      if (/mp4upload\.com/i.test(u)) {
        direct = await extractMp4upload(prov.rawUrl);
      } else if (/uqload/i.test(u)) {
        direct = await extractUqload(prov.rawUrl);
      } else if (/doodstream|d-s\.io|dood/i.test(u)) {
        direct = await extractDoodstream(prov.rawUrl);
      }

      streams.push({
        title: prov.title + (direct ? "" : " (embed)"),
        streamUrl: direct || prov.rawUrl,
        headers: { Referer: direct ? prov.rawUrl : url, "User-Agent": "Mozilla/5.0" },
      });
    }

    return JSON.stringify({ streams });
  } catch {
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
