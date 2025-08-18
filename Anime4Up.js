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

  const getPage = async (pageUrl) => {
    try {
      const res = await fetchv2(pageUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": url }
      });
      return await res.text();
    } catch {
      return "";
    }
  };

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    const firstHtml = await getPage(url);

    // نوع الأنمي
    const typeMatch = firstHtml.match(/<div class="anime-info"><span>النوع:<\/span>\s*([^<]+)<\/div>/i);
    const type = typeMatch ? typeMatch[1].trim().toLowerCase() : "";
    if (type.includes("movie") || type.includes("فيلم")) return JSON.stringify([{ href: url, number: 1 }]);

    // روابط الصفحات
    const paginationRegex = /<a[^>]+href="([^"]+\/page\/\d+\/?)"[^>]*class="page-numbers"/gi;
    const pagesSet = new Set();
    let match;
    while ((match = paginationRegex.exec(firstHtml)) !== null) pagesSet.add(match[1]);
    pagesSet.add(url); // الصفحة الأولى
    const pages = Array.from(pagesSet).sort((a,b) => {
      const nA = parseInt(a.match(/\/page\/(\d+)\//)?.[1]||0);
      const nB = parseInt(b.match(/\/page\/(\d+)\//)?.[1]||0);
      return nA - nB;
    });

    // جلب الصفحات على دفعات صغيرة
    const batchSize = 5; // كل دفعة 5 صفحات
    for (let i = 0; i < pages.length; i += batchSize) {
      const batch = pages.slice(i, i + batchSize);
      const htmlPages = await Promise.all(batch.map(p => getPage(p)));

      // استخراج الحلقات لكل صفحة
      for (const html of htmlPages) {
        const episodeRegex = /<div class="episodes-card-title">\s*<h3>\s*<a\s+href="([^"]+)">[^<]*الحلقة\s*(\d+)[^<]*<\/a>/gi;
        let epMatch;
        while ((epMatch = episodeRegex.exec(html)) !== null) {
          const episodeUrl = epMatch[1].trim();
          const episodeNumber = parseInt(epMatch[2].trim(), 10);
          if (!isNaN(episodeNumber)) results.push({ href: episodeUrl, number: episodeNumber });
        }
      }

      // تأخير صغير بين الدفعات لتقليل الضغط
      if (i + batchSize < pages.length) await sleep(300); // 0.3 ثانية
    }

    results.sort((a, b) => a.number - b.number);

    if (results.length === 0) return JSON.stringify([{ href: url, number: 1 }]);
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
        return await fetchv2(
          u,
          opts.headers || {},
          opts.method || "GET",
          opts.body || null
        );
      }
      return await fetch(u, {
        method: opts.method || "GET",
        headers: opts.headers || {},
        body: opts.body || null,
      });
    } catch {
      return null;
    }
  }

  function normalizeUrl(raw, base = "") {
    if (!raw) return raw;
    raw = String(raw).trim();
    if (raw.startsWith("//")) return "https:" + raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    try {
      return new URL(raw, base || "https://").href;
    } catch {
      return raw.startsWith("/")
        ? "https://" + raw.replace(/^\/+/, "")
        : "https://" + raw;
    }
  }

  // ==== Extractors ====
  async function extractMp4upload(embedUrl) {
    try {
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
      if (!res) return null;
      const html = await res.text();
      let match =
        html.match(/src:\s*"([^"]+\.mp4)"/) ||
        html.match(/file:\s*"([^"]+\.mp4)"/) ||
        html.match(/player\.src\(\{\s*file:\s*"([^"]+\.mp4)"/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async function extractUqload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, {
      headers: { Referer: embedUrl, Origin: "https://uqload.net", "User-Agent": "Mozilla/5.0" },
    });
    if (!res) return null;
    const html = await res.text();
    const match =
      html.match(/sources:\s*\[\s*["']([^"']+\.mp4[^"']*)["']/i) ||
      html.match(/sources\s*=\s*\[["']([^"']+\.mp4[^"']*)["']/i) ||
      html.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
    return match ? normalizeUrl(match[1] || match[0], embedUrl) : null;
  }

  // ==== DoodStream بعد Uqload ====
  async function extractDoodStream(embedUrl) {
    try {
      const res = await httpGet(embedUrl);
      if (!res) return null;
      const html = await res.text();
      if (!html) return null;
      return await doodstreamExtractor(html, embedUrl);
    } catch {
      return null;
    }
  }

  // ==== Main ====
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const anchorRe = /<a\b[^>]*data-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const blockedKeywords = ["mega", "megamax", "dailymotion"];
    const providers = [];
    const seen = new Set();

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

    const streams = [];
    for (const prov of providers) {
      let direct = null;
      try {
        if (/mp4upload\.com/i.test(prov.rawUrl)) direct = await extractMp4upload(prov.rawUrl);
        else if (/uqload/i.test(prov.rawUrl)) direct = await extractUqload(prov.rawUrl);
        else if (/doodstream\.com/i.test(prov.rawUrl)) direct = await extractDoodStream(prov.rawUrl);

        if (!direct) {
          const r = await httpGet(prov.rawUrl, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
          if (r) {
            const txt = await r.text();
            const f = txt.match(/https?:\/\/[^"'<>\s]+\.(?:m3u8|mp4)[^"'<>\s]*/i);
            if (f && f[0]) direct = normalizeUrl(f[0], prov.rawUrl);
          }
        }
      } catch {}

      if (direct) streams.push({ title: prov.title, streamUrl: direct, headers: { Referer: prov.rawUrl, "User-Agent": "Mozilla/5.0" } });
    }

    return JSON.stringify({ streams });
  } catch (e) {
    console.log("extractStreamUrl error:", e);
    return JSON.stringify({ streams: [] });
  }
}

// ==== DoodStream Extractor + randomStr ====
async function doodstreamExtractor(html, url = null) {
  const streamDomain = url.match(/https:\/\/(.*?)\//)[1];
  const md5Path = html.match(/'\/pass_md5\/(.*?)',/)[1];
  const token = md5Path.substring(md5Path.lastIndexOf("/") + 1);
  const expiryTimestamp = Date.now();
  const random = randomStr(10);
  const passResponse = await fetch(`https://${streamDomain}/pass_md5/${md5Path}`, { headers: { "Referer": url } });
  const responseData = await passResponse.text();
  return `${responseData}${random}?token=${token}&expiry=${expiryTimestamp}`;
}

function randomStr(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
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
