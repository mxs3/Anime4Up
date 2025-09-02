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
  try {
    async function getPage(u) {
      const res = await fetchv2(u);
      if (!res) return "";
      return await res.text();
    }

    const firstHtml = await getPage(url);
    if (!firstHtml) return JSON.stringify([]);

    // تحديد أقصى عدد صفحات
    const maxPage = Math.max(
      1,
      ...[...firstHtml.matchAll(/\/page\/(\d+)\//g)].map(m => +m[1])
    );

    // تحميل كل الصفحات
    const pages = await Promise.all(
      Array.from({ length: maxPage }, (_, i) =>
        getPage(i ? `${url.replace(/\/$/, "")}/page/${i + 1}/` : url)
      )
    );

    // Map لتجنب التكرار
    const episodesMap = new Map();

    // هنصطاد بس الروابط اللي فيها كلمة episode
    const linkRegex = /<a[^>]+href="([^"]+episode[^"]+)"[^>]*>(.*?)<\/a>/gi;
    const numRegex = /(?:Episode|الحلقة|Ep)\s*(\d+)/i;

    for (const html of pages) {
      let m;
      while ((m = linkRegex.exec(html))) {
        const href = m[1].trim();
        const text = m[2].trim();
        const numMatch = text.match(numRegex);

        if (!href) continue;

        let number = numMatch ? parseInt(numMatch[1]) : null;

        if (!episodesMap.has(href)) {
          episodesMap.set(href, {
            href,
            number
          });
        }
      }
    }

    // تحويل الـ Map لـ Array
    const unique = Array.from(episodesMap.values());

    // ترتيب حسب رقم الحلقة
    unique.sort((a, b) => {
      if (a.number == null) return 1;
      if (b.number == null) return -1;
      return a.number - b.number;
    });

    return JSON.stringify(unique);

  } catch (error) {
    console.log("Fetch error:", error);
    return JSON.stringify([]);
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

  async function httpGetWithTimeout(u, opts = {}, timeout = 10000) {
    return Promise.race([
      httpGet(u, opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeout))
    ]);
  }

  function safeTrim(s) {
    return s ? String(s).trim() : "";
  }

  function normalizeUrl(raw, base = "") {
    if (!raw) return raw;
    raw = safeTrim(raw);

    if (raw.startsWith("//")) return "https:" + raw;
    try {
      if (base) {
        return new URL(raw, base).href;
      } else {
        if (raw.startsWith("/")) return "https://" + raw.replace(/^\/+/, "");
        if (/^[a-z0-9_\-\.]+\//i.test(raw)) return "https://" + raw;
        if (/^https?:\/\//i.test(raw)) return raw;
        return "https://" + raw;
      }
    } catch {
      if (/^https?:\/\//i.test(raw)) return raw;
      return raw.startsWith("/") ? ("https://" + raw.replace(/^\/+/, "")) : ("https://" + raw);
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

  function randomStr(length) {
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) result += characters.charAt(Math.floor(Math.random() * characters.length));
    return result;
  }

  // ==== Extractors ====
  async function extractMp4upload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGetWithTimeout(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    if (html.includes("video you are looking for is not found")) return null;

    let match = html.match(/player\.src\(\{\s*(?:file|src)\s*:\s*["']([^"']+)["']/i);
    if (match && match[1]) return normalizeUrl(match[1], embedUrl);

    let found = html.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
    if (found && found[0]) return normalizeUrl(found[0], embedUrl);
    return null;
  }

  async function extractDoodstream(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGetWithTimeout(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();

    let md5PathMatch = html.match(/\/pass_md5\/([a-zA-Z0-9\/\-_\.]+)['"]/i) || html.match(/pass_md5=([a-zA-Z0-9\/\-_\.]+)/i);
    if (!md5PathMatch) {
      const found = html.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
      if (found && found[0]) return normalizeUrl(found[0], embedUrl);
      return null;
    }
    const md5Path = md5PathMatch[1].replace(/['"]/g, "");
    const streamDomainMatch = embedUrl.match(/^https?:\/\/([^\/]+)/i);
    if (!streamDomainMatch) return null;
    const streamDomain = streamDomainMatch[1];
    const token = md5Path.substring(md5Path.lastIndexOf("/") + 1);
    const expiryTimestamp = new Date().valueOf();
    const random = randomStr(10);

    const passResponse = await httpGetWithTimeout(`https://${streamDomain}/pass_md5/${md5Path}`, {
      headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" },
    });
    if (!passResponse) return null;

    const responseData = await passResponse.text();
    const videoUrlCandidate = responseData.trim();
    let videoUrl = videoUrlCandidate;
    if (!/https?:\/\//i.test(videoUrlCandidate)) {
      videoUrl = `${videoUrlCandidate}${random}?token=${token}&expiry=${expiryTimestamp}`;
    } else {
      videoUrl = `${videoUrlCandidate}${videoUrlCandidate.includes("?") ? "&" : "?"}token=${token}&expiry=${expiryTimestamp}`;
    }
    return normalizeUrl(videoUrl, embedUrl);
  }

  async function extractUqload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const headers = { Referer: embedUrl, Origin: "https://uqload.net", "User-Agent": "Mozilla/5.0" };
    const res = await httpGetWithTimeout(embedUrl, { headers });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/sources:\s*\[\s*["']([^"']+\.mp4[^"']*)["']\s*\]/i);
    if (match && match[1]) return normalizeUrl(match[1], embedUrl);
    const match2 = html.match(/sources\s*=\s*\[["']([^"']+\.mp4[^"']*)["']\]/i);
    if (match2 && match2[1]) return normalizeUrl(match2[1], embedUrl);
    const f = html.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
    if (f && f[0]) return normalizeUrl(f[0], embedUrl);
    return null;
  }

  // ==== Main ====
  try {
    const pageRes = await httpGetWithTimeout(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const anchorRe = /<a\b[^>]*\bdata-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const iframeRe = /<iframe[^>]+src=(?:(['"])(.*?)\1|([^\s>]+))/gi;

    // الفلترة الجديدة
    const blockedKeywords = ["mega", "megamax", "dailymotion", "vk", "voe", "videa"];
    const providers = [];
    const seen = new Set();

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

    // هنا بقى نشغل السيرفرات Parallel
    const results = await Promise.allSettled(providers.map(async (prov) => {
      const u = prov.rawUrl.toLowerCase();
      let direct = null;

      if (/mp4upload\.com/i.test(u)) {
        direct = await extractMp4upload(prov.rawUrl);
      } else if (/uqload/i.test(u)) {
        direct = await extractUqload(prov.rawUrl);
      } else if (/doodstream|d-s\.io|dood/i.test(u)) {
        direct = await extractDoodstream(prov.rawUrl);
      }

      if (!direct) {
        try {
          const r = await httpGetWithTimeout(prov.rawUrl, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
          if (r) {
            const txt = await r.text();
            const found = txt.match(/https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*/i) || txt.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
            if (found && found[0]) direct = normalizeUrl(found[0], prov.rawUrl);
          }
        } catch {}
      }

      if (direct) {
        return { title: prov.title, streamUrl: direct, headers: { Referer: prov.rawUrl, "User-Agent": "Mozilla/5.0" } };
      } else {
        return { title: prov.title + " (embed)", streamUrl: prov.rawUrl, headers: { Referer: url, "User-Agent": "Mozilla/5.0" } };
      }
    }));

    const streams = results.filter(r => r.status === "fulfilled" && r.value).map(r => r.value);

    return JSON.stringify({ streams });
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
