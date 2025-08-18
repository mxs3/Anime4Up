async function searchResults(keyword) {
  try {
    const url = `https://ww.anime4up.rest/?search_param=animes&s=${encodeURIComponent(keyword)}`;
    const res = await fetchv2(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://ww.anime4up.rest/'
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

    // === 1. Ø£ÙÙ ØµÙØ­Ø© ===
    const firstHtml = await getPage(url);

    // ÙÙØ¹ (ÙÙÙÙ ÙÙØ§ ÙØ³ÙØ³Ù)
    const typeMatch = firstHtml.match(/<div class="anime-info"><span>Ø§ÙÙÙØ¹:<\/span>\s*([^<]+)<\/div>/i);
    const type = typeMatch ? typeMatch[1].trim().toLowerCase() : "";

    if (type.includes("movie") || type.includes("ÙÙÙÙ")) {
      return JSON.stringify([{ href: url, number: 1 }]);
    }

    // === 2. ÙØ¬ÙØ¨ Ø¢Ø®Ø± Ø±ÙÙ ØµÙØ­Ø© ===
    let maxPage = 1;
    const pageNumMatches = [...firstHtml.matchAll(/\/page\/(\d+)\//g)];
    if (pageNumMatches.length) {
      const nums = pageNumMatches.map(m => parseInt(m[1], 10));
      maxPage = Math.max(...nums);
    }

    // === 3. ÙÙÙÙØ¯ ÙÙ Ø§ÙØµÙØ­Ø§Øª 1 â maxPage ===
    const pages = [];
    for (let i = 1; i <= maxPage; i++) {
      pages.push(i === 1 ? url : `${url.replace(/\/$/, "")}/page/${i}/`);
    }

    // === 4. ÙØ§Øª ÙÙ Ø§ÙØµÙØ­Ø§Øª ÙØ±ÙØ© ÙØ§Ø­Ø¯Ø© ===
    const htmlPages = await Promise.all(pages.map(p => getPage(p)));

    // === 5. Ø§Ø³ØªØ®Ø±Ø¬ Ø§ÙØ­ÙÙØ§Øª ===
    for (const html of htmlPages) {
      const episodeRegex = /<div class="episodes-card-title">\s*<h3>\s*<a\s+href="([^"]+)">[^<]*Ø§ÙØ­ÙÙØ©\s*(\d+)[^<]*<\/a>/gi;
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

    // === 6. Ø±ØªØ¨ Ø§ÙØ­ÙÙØ§Øª ===
    results.sort((a, b) => a.number - b.number);

    // === 7. fallback ===
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
      if (hasFetchV2) return await fetchv2(u, opts.headers || {}, opts.method || "GET", opts.body || null);
      return await fetch(u, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body || null });
    } catch { return null; }
  }

  function normalizeUrl(raw, base = "") {
    if (!raw) return raw;
    raw = String(raw).trim();
    if (raw.startsWith("//")) return "https:" + raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    try { return new URL(raw, base || "https://").href; } catch { return raw.startsWith("/") ? "https://" + raw.replace(/^\/+/, "") : "https://" + raw; }
  }

  // ==== Extractors ====
  async function extractMp4upload(embedUrl) {
    try {
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
      if (!res) return null;
      const html = await res.text();
      const match = html.match(/src:\s*"([^"]+\.mp4)"/) || html.match(/file:\s*"([^"]+\.mp4)"/) || html.match(/player\.src\(\{\s*file:\s*"([^"]+\.mp4)"/);
      return match ? match[1] : null;
    } catch { return null; }
  }

  async function extractUqload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, Origin: "https://uqload.net", "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/sources:\s*\[\s*["']([^"']+\.mp4[^"']*)["']/i) || html.match(/sources\s*=\s*\[["']([^"']+\.mp4[^"']*)["']/i) || html.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
    return match ? normalizeUrl(match[1] || match[0], embedUrl) : null;
  }

  async function extractDoodStream(embedUrl) {
    try {
      const res = await httpGet(embedUrl);
      if (!res) return null;
      const html = await res.text();
      if (!html) return null;

      const streamDomain = embedUrl.match(/https:\/\/(.*?)\//)[1];
      const md5Path = html.match(/'\/pass_md5\/(.*?)',/)[1];
      const token = md5Path.substring(md5Path.lastIndexOf("/") + 1);
      const expiryTimestamp = Date.now();
      const random = (() => {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let str = "";
        for (let i = 0; i < 10; i++) str += chars.charAt(Math.floor(Math.random() * chars.length));
        return str;
      })();

      const passResponse = await httpGet(`https://${streamDomain}/pass_md5/${md5Path}`, { headers: { Referer: embedUrl } });
      const responseData = await passResponse.text();
      return `${responseData}${random}?token=${token}&expiry=${expiryTimestamp}`;
    } catch { return null; }
  }

  async function extractStreamwish(embedUrl) {
    try {
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
      if (!res) return null;
      const html = await res.text();
      const match = html.match(/sources:\s*\[\s*\{file:"([^"]+)"/i) || html.match(/file:\s*"([^"]+\.(?:mp4|m3u8))"/i);
      return match ? normalizeUrl(match[1], embedUrl) : null;
    } catch { return null; }
  }

  async function extractVidea(embedUrl) {
    try {
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
      if (!res) return null;
      const html = await res.text();
      const match = html.match(/"(https?:\/\/[^"]+\/(mp4|m3u8)[^"]*)"/i);
      return match ? normalizeUrl(match[1], embedUrl) : null;
    } catch { return null; }
  }

  // ==== Main ====
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const anchorRe = /<a\b[^>]*data-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const blockedKeywords = ["mega", "megamax", "dailymotion"];
    const providers = [], seen = new Set();

    let match;
    while ((match = anchorRe.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(match[2] || match[3] || "", url);
      let title = (match[4] || rawUrl).replace(/\s+/g, " ").trim();
      if (seen.has(rawUrl)) continue;
      if (blockedKeywords.some(kw => rawUrl.toLowerCase().includes(kw) || title.toLowerCase().includes(kw))) continue;
      seen.add(rawUrl);
      providers.push({ rawUrl, title });
    }

    if (!providers.length) return JSON.stringify({ streams: [] });

    const streams = await Promise.all(providers.map(async (prov) => {
      let direct = null;
      try {
        if (/mp4upload\.com/i.test(prov.rawUrl)) direct = await extractMp4upload(prov.rawUrl);
        else if (/uqload/i.test(prov.rawUrl)) direct = await extractUqload(prov.rawUrl);
        else if (/doodstream\.com/i.test(prov.rawUrl)) direct = await extractDoodStream(prov.rawUrl);
        else if (/streamwish/i.test(prov.rawUrl)) direct = await extractStreamwish(prov.rawUrl);
        else if (/videa/i.test(prov.rawUrl)) direct = await extractVidea(prov.rawUrl);

        if (!direct) {
          const r = await httpGet(prov.rawUrl, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
          if (r) {
            const txt = await r.text();
            const f = txt.match(/https?:\/\/[^"'<>\s]+\.(?:m3u8|mp4)[^"'<>\s]*/i);
            if (f && f[0]) direct = normalizeUrl(f[0], prov.rawUrl);
          }
        }
      } catch {}
      return direct ? { title: prov.title, streamUrl: direct, headers: { Referer: prov.rawUrl, "User-Agent": "Mozilla/5.0" } } : null;
    }));

    return JSON.stringify({ streams: streams.filter(Boolean) });
  } catch (e) {
    console.log("extractStreamUrl error:", e);
    return JSON.stringify({ streams: [] });
  }
}

function decodeHTMLEntities(text) {
    text = text.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));

    const entities = {
        '&quot;': '"',
        '&amp;': '&',
        '&apos;': "'",
        '&lt;': '<',
        '&gt;': '>'
    };

    for (const entity in entities) {
        text = text.replace(new RegExp(entity, 'g'), entities[entity]);
    }

    return text;
}
