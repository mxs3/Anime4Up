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

  // ==== mp4upload Extractor ====
  async function extractMp4upload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, {
      headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" }
    });
    if (!res) return null;
    const html = await res.text();

    const regex = /src:\s*"([^"]+)"/;
    const match = html.match(regex);
    if (match) {
      return normalizeUrl(match[1], embedUrl);
    } else {
      return null;
    }
  }

  // ==== uqload Extractor ====
  async function extractUqload(embedUrl) {
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/sources:\s*\[\s*["']([^"']+\.mp4[^"']*)["']/i);
    if (match) return normalizeUrl(match[1], embedUrl);
    const found = html.match(/https?:\/\/[^"']+\.mp4[^"']*/i);
    return found ? normalizeUrl(found[0], embedUrl) : null;
  }

  // ==== sendvid Extractor ====
  async function extractSendvid(embedUrl) {
    const res = await httpGet(embedUrl, { headers: { Referer: "https://sendvid.com/", "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/file:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
    if (match) return normalizeUrl(match[1], embedUrl);
    const found = html.match(/https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*/i);
    return found ? normalizeUrl(found[0], embedUrl) : null;
  }

  // ==== DoodStream Extractor ====
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
          server: "DoodStream"
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

      return [{ quality: "DoodStream", url: baseUrl, type: "mp4", server: "DoodStream" }];

    } catch (err) {
      console.log("extractDoodstream error:", err);
      return null;
    }
  }

  // ==== Vadbam Extractor ====
  async function extractVadbam(embedUrl) {
    try {
      const res = await httpGet(embedUrl, {
        headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" },
        redirect: "follow"
      });
      if (!res) return null;
      let html = await res.text();
      html = html.replace(/\\+/g, "");

      const results = [];

      const mp4Matches = [...html.matchAll(/https?:\/\/[^\s"'<>]+?\.mp4(?:\?[^"'<>]*)?/gi)];
      for (const m of mp4Matches) {
        let quality = "Vadbam";
        const qMatch = m[0].match(/(\d{3,4}p)/i);
        if (qMatch) quality = qMatch[1];
        results.push({ quality, url: normalizeUrl(m[0], embedUrl), type: "mp4", server: "Vadbam" });
      }

      const fileJsonMatches = [...html.matchAll(/"file"\s*:\s*"([^"]+\.mp4[^"]*)"/gi)];
      for (const fm of fileJsonMatches) {
        results.push({ quality: "auto", url: normalizeUrl(fm[1], embedUrl), type: "mp4", server: "Vadbam" });
      }

      return results.length ? results : null;
    } catch (err) {
      console.log("extractVadbam error:", err);
      return null;
    }
  }

  // ==== VK Extractor (دمج محسّن) ====
  async function extractVK(embedUrl) {
    const headers = { "Referer": "https://vk.com/" };
    try {
      const res = await httpGet(embedUrl, { headers, method: "GET" });
      if (!res) return null;
      const html = await res.text();

      const qualities = {};

      const hlsMatch = html.match(/"hls"\s*:\s*"([^"]+)"/);
      if (hlsMatch && hlsMatch[1]) qualities["hls"] = unescapeVK(hlsMatch[1]);

      const mp4Matches = [...html.matchAll(/"url(\d+)"\s*:\s*"([^"]+)"/g)];
      for (const m of mp4Matches) {
        const q = m[1] + "p";
        const link = unescapeVK(m[2]);
        qualities[q] = link;
      }

      if (!Object.keys(qualities).length) return null;

      return { streams: qualities, headers };
    } catch (err) {
      console.log("extractVK error:", err.message);
      return null;
    }
  }

  // ==== Main ====
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const anchorRe = /<a\b[^>]*\bdata-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const providers = [];
    const seen = new Set();
    let m;
    while ((m = anchorRe.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(m[2] || m[3] || "", url);
      if (!rawUrl || seen.has(rawUrl)) continue;
      seen.add(rawUrl);
      providers.push({ rawUrl, title: (m[4] || rawUrl).trim() });
    }

    if (providers.length === 0) {
      const iframeMatches = [...pageHtml.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)];
      for (const im of iframeMatches) {
        const rawUrl = normalizeUrl(im[1], url);
        if (!rawUrl || seen.has(rawUrl)) continue;
        seen.add(rawUrl);
        providers.push({ rawUrl, title: rawUrl });
      }
    }

    const results = await Promise.all(providers.map(async prov => {
      const u = prov.rawUrl.toLowerCase();
      let direct = null;

      if (/mp4upload/.test(u)) direct = await extractMp4upload(prov.rawUrl);
      else if (/uqload/.test(u)) direct = await extractUqload(prov.rawUrl);
      else if (/(dood|vide0\.net|doodstream|dood\.watch|dood\.so)/.test(u)) direct = await extractDoodstream(prov.rawUrl);
      else if (/sendvid/.test(u)) direct = await extractSendvid(prov.rawUrl);
      else if (/(vadbam|vdbtm)/i.test(u)) direct = await extractVadbam(prov.rawUrl);
      else if (/vkvideo\.ru/.test(u) || /vk\.com\/video/.test(u) || /vk\.com\/video_ext\.php/.test(u)) direct = await extractVK(prov.rawUrl);

      if (!direct) return null;

      if (Array.isArray(direct)) {
        return direct.map(d => ({
          title: `${prov.title} [${d.quality || "auto"}]`,
          streamUrl: d.url,
          type: d.type || "mp4",
          headers: d.headers || { Referer: prov.rawUrl }
        }));
      }

      if (direct.streams) {
        return Object.entries(direct.streams).map(([q, link]) => ({
          title: `${prov.title} [${q}]`,
          streamUrl: link,
          type: /\.m3u8/.test(link) ? "hls" : "mp4",
          headers: direct.headers || { Referer: prov.rawUrl }
        }));
      }

      return { title: prov.title, streamUrl: direct.url || direct, headers: { Referer: prov.rawUrl } };
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
