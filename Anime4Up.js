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
      if (hasFetchV2)
        return await fetchv2(
          u,
          opts.headers || {},
          opts.method || "GET",
          opts.body || null
        );
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

  // helper: timeout wrapper
  async function withTimeout(promise, ms = 7000) {
    let timeout;
    const timer = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Timeout")), ms);
    });
    return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
  }

  // ==== Extractors (نفس اللي عندك بالظبط) ====
  async function extractMp4upload(embedUrl) {
    try {
      const res = await httpGet(embedUrl, {
        headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" },
      });
      if (!res) return null;
      const html = await res.text();
      const match =
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
      headers: {
        Referer: embedUrl,
        Origin: "https://uqload.net",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!res) return null;
    const html = await res.text();
    const match =
      html.match(/sources:\s*\[\s*["']([^"']+\.mp4[^"']*)["']/i) ||
      html.match(/sources\s*=\s*\[["']([^"']+\.mp4[^"']*)["']/i) ||
      html.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
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
        const chars =
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let str = "";
        for (let i = 0; i < 10; i++)
          str += chars.charAt(Math.floor(Math.random() * chars.length));
        return str;
      })();

      const passResponse = await httpGet(
        `https://${streamDomain}/pass_md5/${md5Path}`,
        { headers: { Referer: embedUrl } }
      );
      const responseData = await passResponse.text();
      return `${responseData}${random}?token=${token}&expiry=${expiryTimestamp}`;
    } catch {
      return null;
    }
  }

  async function extractStreamwish(embedUrl) {
    try {
      const res = await httpGet(embedUrl, {
        headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" },
      });
      if (!res) return null;
      const html = await res.text();
      const match =
        html.match(/sources:\s*\[\s*\{file:"([^"]+)"/i) ||
        html.match(/file:\s*"([^"]+\.(?:mp4|m3u8))"/i);
      return match ? normalizeUrl(match[1], embedUrl) : null;
    } catch {
      return null;
    }
  }

  async function extractVidea(embedUrl) {
    try {
      const res = await httpGet(embedUrl, {
        headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" },
      });
      if (!res) return null;
      const html = await res.text();
      const match = html.match(/"(https?:\/\/[^"]+\/(mp4|m3u8)[^"]*)"/i);
      return match ? normalizeUrl(match[1], embedUrl) : null;
    } catch {
      return null;
    }
  }

  // ==== Main ====
  try {
    const pageRes = await httpGet(url, {
      headers: { Referer: url, "User-Agent": "Mozilla/5.0" },
    });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const anchorRe =
      /<a\b[^>]*data-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const blockedKeywords = ["mega", "megamax", "dailymotion"];
    const providers = [],
      seen = new Set();

    let match;
    while ((match = anchorRe.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(match[2] || match[3] || "", url);
      let title = (match[4] || rawUrl).replace(/\s+/g, " ").trim();
      if (seen.has(rawUrl)) continue;
      if (
        blockedKeywords.some(
          (kw) =>
            rawUrl.toLowerCase().includes(kw) || title.toLowerCase().includes(kw)
        )
      )
        continue;
      seen.add(rawUrl);
      providers.push({ rawUrl, title });
    }

    if (!providers.length) return JSON.stringify({ streams: [] });

    // extract in parallel with timeout
    const tasks = providers.map(async (prov) => {
      try {
        let direct = null;
        if (/mp4upload\.com/i.test(prov.rawUrl))
          direct = await withTimeout(extractMp4upload(prov.rawUrl));
        else if (/uqload/i.test(prov.rawUrl))
          direct = await withTimeout(extractUqload(prov.rawUrl));
        else if (/doodstream\.com/i.test(prov.rawUrl))
          direct = await withTimeout(extractDoodStream(prov.rawUrl));
        else if (/streamwish/i.test(prov.rawUrl))
          direct = await withTimeout(extractStreamwish(prov.rawUrl));
        else if (/videa/i.test(prov.rawUrl))
          direct = await withTimeout(extractVidea(prov.rawUrl));

        // fallback scan
        if (!direct) {
          const r = await withTimeout(
            httpGet(prov.rawUrl, {
              headers: { Referer: url, "User-Agent": "Mozilla/5.0" },
            })
          );
          if (r) {
            const txt = await r.text();
            const f = txt.match(
              /https?:\/\/[^"'<>\s]+\.(?:m3u8|mp4)[^"'<>\s]*/i
            );
            if (f && f[0]) direct = normalizeUrl(f[0], prov.rawUrl);
          }
        }

        return direct
          ? {
              title: prov.title,
              streamUrl: direct,
              headers: { Referer: prov.rawUrl, "User-Agent": "Mozilla/5.0" },
            }
          : null;
      } catch {
        return null;
      }
    });

    const streams = (await Promise.all(tasks)).filter(Boolean);
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
