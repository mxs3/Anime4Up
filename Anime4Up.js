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

  // ==== mp4upload Extractor ====
  async function extractMp4upload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, {
      headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" }
    });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/src:\s*"([^"]+)"/);
    return match ? normalizeUrl(match[1], embedUrl) : null;
  }

  // ==== uqload Extractor (Fixed) ====
  async function extractUqload(embedUrl) {
    try {
      const res = await httpGet(embedUrl, {
        headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" }
      });
      if (!res) return null;
      const html = await res.text();

      // محاولة استخراج اللينك من sources
      const match = html.match(/sources:\s*\[\s*["']([^"']+\.mp4[^"']*)["']/i);
      if (match) return normalizeUrl(match[1], embedUrl);

      // استخراج من <source src="">
      const tagMatch = html.match(/<source\s+src=["']([^"']+\.mp4[^"']*)["']/i);
      if (tagMatch) return normalizeUrl(tagMatch[1], embedUrl);

      // أي لينك mp4 عشوائي
      const found = html.match(/https?:\/\/[^"']+\.mp4[^"']*/i);
      return found ? normalizeUrl(found[0], embedUrl) : null;
    } catch {
      return null;
    }
  }

  // ==== DoodStream Extractor ====
  async function extractDoodstream(embedUrl) {
    try {
      function randomStr(len) {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
      }

      const pageRes = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
      if (!pageRes) return null;
      const html = await pageRes.text();

      const md5Match = html.match(/\/pass_md5\/[a-z0-9\/\-_\.]+/i);
      if (!md5Match) {
        const directMatches = [...html.matchAll(/https?:\/\/[^\s"'<>]+(?:m3u8|mp4)[^"'<>]*/gi)];
        if (!directMatches.length) return null;
        return directMatches.map(m => ({
          quality: "(HD)",
          url: normalizeUrl(m[0], embedUrl),
          type: "mp4",
          server: "DoodStream"
        }));
      }

      const md5Path = md5Match[0];
      const domain = new URL(embedUrl).origin;
      const passUrl = `${domain}${md5Path}`;
      const passRes = await httpGet(passUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
      if (!passRes) return null;
      const tokenPart = (await passRes.text()).trim();
      if (!tokenPart) return null;

      const token = md5Path.split("/").pop();
      const expiry = Date.now();
      const random = randomStr(10);
      const baseUrl = `${tokenPart}${random}?token=${token}&expiry=${expiry}`;

      return [{ quality: "(HD)", url: baseUrl, type: "mp4", server: "DoodStream" }];
    } catch {
      return null;
    }
  }

  // ==== VK Extractor ====
  async function extractVK(embedUrl) {
    try {
      const response = await httpGet(embedUrl, {
        headers: { Referer: "https://vk.com/", "User-Agent": "Mozilla/5.0" },
        method: "GET"
      });
      if (!response) return null;
      const html = await response.text();

      const hlsMatch = html.match(/"hls"\s*:\s*"([^"]+)"/);
      if (hlsMatch && hlsMatch[1]) {
        return [{ quality: "(HD)", url: hlsMatch[1].replace(/\\\//g, "/"), type: "hls", server: "VK" }];
      }
      return null;
    } catch {
      return null;
    }
  }

  // ==== Main ====
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const providers = [];
    const seen = new Set();
    const serverRegex = /data-watch=["']([^"']+)["'][^>]*>\s*([^<\[]+)/gi;
    let match;
    while ((match = serverRegex.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(match[1], url);
      const title = match[2].trim();
      if (!seen.has(rawUrl)) {
        seen.add(rawUrl);
        providers.push({ rawUrl, title });
      }
    }

    const results = await Promise.all(
      providers.map(async prov => {
        const u = prov.rawUrl.toLowerCase();
        let direct = null;

        if (/mp4upload/.test(u)) direct = await extractMp4upload(prov.rawUrl);
        else if (/uqload/.test(u)) direct = await extractUqload(prov.rawUrl);
        else if (/(dood|dsvplay)/.test(u)) direct = await extractDoodstream(prov.rawUrl);
        else if (/vkvideo|vk\.com/.test(u)) direct = await extractVK(prov.rawUrl);
        else if (/vidmoly/.test(u)) direct = prov.rawUrl; // Vidmoly direct link

        if (!direct) return null;

        if (Array.isArray(direct)) {
          return direct.map(d => ({
            title: `${prov.title} ${d.quality || ""}`,
            streamUrl: d.url,
            type: d.type || "mp4",
            headers: { Referer: prov.rawUrl }
          }));
        }

        return {
          title: `${prov.title} (HD)`,
          streamUrl: typeof direct === "string" ? direct : direct.url,
          type: /\.m3u8/.test(direct) ? "hls" : "mp4",
          headers: { Referer: prov.rawUrl }
        };
      })
    );

    return JSON.stringify({ streams: results.flat().filter(Boolean) });
  } catch (e) {
    return JSON.stringify({ streams: [] });
  }
}
