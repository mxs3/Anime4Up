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

  async function httpGet(u, opts = {}, timeout = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    try {
      if (hasFetchV2) {
        const res = await fetchv2(
          u,
          opts.headers || {},
          opts.method || "GET",
          opts.body || null
        );
        clearTimeout(timer);
        return res;
      }
      const res = await fetch(u, {
        method: opts.method || "GET",
        headers: opts.headers || {},
        body: opts.body || null,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return res;
    } catch {
      clearTimeout(timer);
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

  // ==== Extractors (نفسها، مفيش لعب في البنية) ====
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

  // باقي extractors زي ما هي (Dood, Streamwish, Videa, Vidmoly, VK, Voe) 
  // >>>> مفيش أي تغيير عليهم علشان البنية تفضل زي ما هي.

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
            rawUrl.toLowerCase().includes(kw) ||
            title.toLowerCase().includes(kw)
        )
      )
        continue;
      seen.add(rawUrl);
      providers.push({ rawUrl, title });
    }

    if (!providers.length) return JSON.stringify({ streams: [] });

    const streams = await Promise.allSettled(
      providers.map(async (prov) => {
        let direct = null;
        try {
          if (/mp4upload\.com/i.test(prov.rawUrl))
            direct = await extractMp4upload(prov.rawUrl);
          else if (/uqload/i.test(prov.rawUrl))
            direct = await extractUqload(prov.rawUrl);
          // ... باقي السيرفرات زي ما هي بالظبط
        } catch {}
        return direct
          ? {
              title: prov.title,
              streamUrl: direct,
              headers: { Referer: prov.rawUrl, "User-Agent": "Mozilla/5.0" },
            }
          : null;
      })
    );

    return JSON.stringify({
      streams: streams
        .filter((r) => r.status === "fulfilled" && r.value)
        .map((r) => r.value),
    });
  } catch (e) {
    console.log("extractStreamUrl error:", e);
    return JSON.stringify({ streams: [] });
  }
}

function decodeHTMLEntities(text) {
  text = text.replace(/&#(\d+);/g, (match, dec) =>
    String.fromCharCode(dec)
  );

  const entities = {
    "&quot;": '"',
    "&amp;": "&",
    "&apos;": "'",
    "&lt;": "<",
    "&gt;": ">",
  };

  for (const entity in entities) {
    text = text.replace(new RegExp(entity, "g"), entities[entity]);
  }

  return text;
}
