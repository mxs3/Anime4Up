async function searchResults(keyword) {
  try {
    const url = `https://ww.anime4up.rest/?s=${encodeURIComponent(keyword)}`;
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
      // الرابط الرئيسي
      const hrefMatch = block.match(/<a[^>]+href="([^"]*\/anime\/[^"]+)"/i);

      // الصورة الجديدة (data-image بدل src)
      const imgMatch = block.match(/data-image=["']([^"']+)["']/i);

      // العنوان
      const titleMatch =
        block.match(/<h3>\s*<a[^>]*>([^<]+)<\/a>/i) ||
        block.match(/title=["']([^"']+)["']/i) ||
        block.match(/alt=["']([^"']+)["']/i);

      if (hrefMatch && titleMatch) {
        results.push({
          title: decodeHTMLEntities(titleMatch[1].trim()),
          href: hrefMatch[1].trim(),
          image: imgMatch ? imgMatch[1].trim() : ''
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

    // استخراج الحلقات من البنية الجديدة
    const episodeRegex = /<a[^>]+href="([^"]+\/episode\/[^"]+)"[^>]*data-src="([^"]+)"[^>]*title="([^"]+)"[\s\S]*?<span>\s*الحلقة\s*(\d+)\s*<\/span>/gi;

    for (const html of pages) {
      let m;
      while ((m = episodeRegex.exec(html))) {
        const href = m[1].trim();
        const image = m[2].trim();
        const title = m[3].trim();
        const number = parseInt(m[4]);

        if (!href || episodesMap.has(href)) continue;

        episodesMap.set(href, {
          href,
          image,
          title,
          number
        });
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
      }
      return await fetch(u, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body || null });
    } catch {
      return null;
    }
  }

  function safeTrim(s) {
    return s ? String(s).trim() : "";
  }

  function normalizeUrl(raw, base = "") {
    if (!raw) return raw;
    raw = safeTrim(raw);
    if (raw.startsWith("//")) return "https:" + raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    try {
      return base ? new URL(raw, base).href : "https://" + raw.replace(/^\/+/, "");
    } catch {
      return raw;
    }
  }

  function unescapeVK(s) {
    return s
      ? s.replace(/\\\//g, "/").replace(/\\u0026/g, "&").replace(/&amp;/g, "&")
      : s;
  }

  // ==== Mp4upload Extractor ====
  async function extractMp4upload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    const regex = /src:\s*"([^"]+)"/;
    const match = html.match(regex);
    if (match) return normalizeUrl(match[1], embedUrl);
    return null;
  }

  // ==== Uqload Extractor (محسّن) ====
  async function extractUqload(embedUrl) {
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    const sources = html.match(/sources\s*:\s*\[\s*{[^}]*file\s*:\s*["']([^"']+)["']/i);
    if (sources) return normalizeUrl(sources[1], embedUrl);
    const found = html.match(/https?:\/\/[^\s"']+\.mp4[^"']*/i);
    return found ? normalizeUrl(found[0], embedUrl) : null;
  }

  // ==== Doodstream Extractor ====
  async function extractDoodstream(embedUrl) {
    try {
      function randomStr(len) {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let result = "";
        for (let i = 0; i < len; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
        return result;
      }

      const pageRes = await httpGet(embedUrl, { headers: { "Referer": embedUrl, "User-Agent": "Mozilla/5.0" } });
      if (!pageRes) return null;
      const html = await pageRes.text();

      const md5Match = html.match(/\/pass_md5\/[a-z0-9\/\-_\.]+/i);
      if (!md5Match) {
        const directMatches = [...html.matchAll(/https?:\/\/[^\s"'<>]+(?:m3u8|mp4)[^"'<>]*/gi)];
        if (!directMatches.length) return null;
        return directMatches.map(m => ({
          quality: "HD",
          url: normalizeUrl(m[0], embedUrl),
          type: "mp4",
          server: "Doodstream"
        }));
      }

      const md5Path = md5Match[0];
      const domainMatch = embedUrl.match(/https?:\/\/([^/]+)/i);
      if (!domainMatch) return null;
      const domain = domainMatch[1];

      const passUrl = `https://${domain}${md5Path}`;
      const passRes = await httpGet(passUrl, { headers: { "Referer": embedUrl, "User-Agent": "Mozilla/5.0" } });
      if (!passRes) return null;
      const tokenPart = (await passRes.text()).trim();
      if (!tokenPart) return null;

      const token = md5Path.split("/").pop();
      const expiry = Date.now();
      const random = randomStr(10);
      const baseUrl = `${tokenPart}${random}?token=${token}&expiry=${expiry}`;

      return [{ quality: "HD", url: baseUrl, type: "mp4", server: "Doodstream" }];
    } catch (err) {
      console.log("extractDoodstream error:", err);
      return null;
    }
  }

  // ==== Vidmoly Extractor ====
  async function extractVidmoly(embedUrl) {
    try {
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
      if (!res) return null;
      const html = await res.text();

      const m3u8Match = html.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i);
      if (m3u8Match) {
        return [{ quality: "auto", url: m3u8Match[1], type: "hls", server: "Vidmoly" }];
      }

      const mp4Match = html.match(/file:\s*["']([^"']+\.mp4[^"']*)["']/i);
      if (mp4Match) {
        return [{ quality: "HD", url: mp4Match[1], type: "mp4", server: "Vidmoly" }];
      }

      const found = html.match(/https?:\/\/[^\s"'<>]+(?:mp4|m3u8)[^"'<>]*/i);
      return found ? [{ quality: "auto", url: found[0], type: "auto", server: "Vidmoly" }] : null;
    } catch (err) {
      console.log("extractVidmoly error:", err);
      return null;
    }
  }

  // ==== VK Extractor ====
  async function extractVK(embedUrl) {
    const headers = { Referer: "https://vk.com/", "User-Agent": "Mozilla/5.0" };
    try {
      const response = await httpGet(embedUrl, { headers });
      if (!response) return null;
      const html = await response.text();
      const results = [];
      const hlsMatch = html.match(/"hls"\s*:\s*"([^"]+)"/);
      if (hlsMatch && hlsMatch[1]) {
        results.push({
          quality: "auto",
          url: hlsMatch[1].replace(/\\\//g, "/"),
          type: "hls",
          server: "VK"
        });
      }
      return results.length ? results : null;
    } catch (error) {
      console.log("extractVK error:", error.message);
      return null;
    }
  }

  // ==== MAIN ====
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const iframeMatches = [...pageHtml.matchAll(/data-watch\s*=\s*["']([^"']+)["']/gi)];
    const providers = [];
    const seen = new Set();

    for (const im of iframeMatches) {
      const rawUrl = normalizeUrl(im[1], url);
      if (!rawUrl || seen.has(rawUrl)) continue;
      seen.add(rawUrl);
      providers.push({ rawUrl });
    }

    const results = await Promise.all(providers.map(async prov => {
      const u = prov.rawUrl.toLowerCase();
      let direct = null, serverName = "";

      if (/mp4upload/.test(u)) { direct = await extractMp4upload(prov.rawUrl); serverName = "Mp4upload"; }
      else if (/uqload/.test(u)) { direct = await extractUqload(prov.rawUrl); serverName = "Uqload"; }
      else if (/dood/.test(u)) { direct = await extractDoodstream(prov.rawUrl); serverName = "Doodstream"; }
      else if (/vidmoly/.test(u)) { direct = await extractVidmoly(prov.rawUrl); serverName = "Vidmoly"; }
      else if (/vkvideo\.ru|vk\.com/.test(u)) { direct = await extractVK(prov.rawUrl); serverName = "VK"; }

      if (!direct) return null;

      if (Array.isArray(direct)) {
        return direct.map(d => ({
          title: `${serverName} [${d.quality || "HD"}]`,
          streamUrl: d.url,
          type: d.type || "mp4",
          headers: { Referer: prov.rawUrl }
        }));
      }

      return { title: `${serverName} [HD]`, streamUrl: direct, headers: { Referer: prov.rawUrl } };
    }));

    return JSON.stringify({ streams: results.flat().filter(Boolean) });
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
