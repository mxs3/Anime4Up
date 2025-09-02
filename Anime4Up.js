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

  function normalizeUrl(u, base) {
    try {
      return new URL(u, base).toString();
    } catch {
      return u;
    }
  }

  // ==== Extractors ====
  async function extractMp4Upload(embedUrl) {
    try {
      const res = await httpGet(embedUrl);
      if (!res) return null;
      const html = await res.text();
      const match = html.match(/src:\s*"([^"]+\.mp4[^"]*)"/i);
      return match ? normalizeUrl(match[1], embedUrl) : null;
    } catch {
      return null;
    }
  }

  async function extractUqload(embedUrl) {
    try {
      const res = await httpGet(embedUrl);
      if (!res) return null;
      const html = await res.text();
      const match =
        html.match(/sources:\s*\[\s*\{file:\s*"([^"]+)"/i) ||
        html.match(/"file":"([^"]+\.mp4)"/i);
      return match ? normalizeUrl(match[1], embedUrl) : null;
    } catch {
      return null;
    }
  }

  async function extractDoodStream(embedUrl) {
    try {
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl } });
      if (!res) return null;
      const html = await res.text();
      const streamDomain = embedUrl.match(/https:\/\/([^/]+)/)?.[1];
      const md5Path = html.match(/'\/pass_md5\/(.*?)',/i)?.[1];
      if (!streamDomain || !md5Path) return null;

      const token = md5Path.split("/").pop();
      const expiryTimestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 12);

      const passResponse = await httpGet(
        `https://${streamDomain}/pass_md5/${md5Path}`,
        { headers: { Referer: embedUrl } }
      );
      if (!passResponse) return null;
      const responseData = await passResponse.text();
      return `${responseData}${random}?token=${token}&expiry=${expiryTimestamp}`;
    } catch {
      return null;
    }
  }

  async function extractStreamwish(embedUrl) {
    try {
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl } });
      if (!res) return null;
      const html = await res.text();
      const match =
        html.match(/sources:\s*\[\s*\{file:\s*"([^"]+)"/i) ||
        html.match(/file:\s*"([^"]+\.(?:mp4|m3u8)[^"]*)"/i) ||
        html.match(/"(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/i) ||
        html.match(/src:\s*"([^"]+\.(?:mp4|m3u8)[^"]*)"/i);
      return match ? normalizeUrl(match[1], embedUrl) : null;
    } catch {
      return null;
    }
  }

  async function extractVidea(embedUrl) {
    try {
      const res = await httpGet(embedUrl);
      if (!res) return null;
      const html = await res.text();
      const match =
        html.match(/src:\s*"([^"]+\.mp4[^"]*)"/i) ||
        html.match(/file:\s*"([^"]+\.mp4[^"]*)"/i);
      return match ? normalizeUrl(match[1], embedUrl) : null;
    } catch {
      return null;
    }
  }

  async function extractVidmoly(embedUrl) {
    try {
      const res = await httpGet(embedUrl);
      if (!res) return null;
      const html = await res.text();
      const match =
        html.match(/sources:\s*\[\s*\{file:\s*"([^"]+)"/i) ||
        html.match(/src:\s*"([^"]+\.(?:mp4|m3u8)[^"]*)"/i);
      return match ? normalizeUrl(match[1], embedUrl) : null;
    } catch {
      return null;
    }
  }

  async function extractVk(embedUrl) {
    try {
      const res = await httpGet(embedUrl);
      if (!res) return null;
      const html = await res.text();
      const match = html.match(/"url(\d+)":"([^"]+)"/i);
      return match ? normalizeUrl(match[2].replace(/\\/g, ""), embedUrl) : null;
    } catch {
      return null;
    }
  }

  async function extractVoe(embedUrl) {
    try {
      const res = await httpGet(embedUrl);
      if (!res) return null;
      const html = await res.text();
      const match =
        html.match(/"hls":\s*"([^"]+\.m3u8[^"]*)"/i) ||
        html.match(/src:\s*"([^"]+\.(?:mp4|m3u8)[^"]*)"/i);
      return match ? normalizeUrl(match[1], embedUrl) : null;
    } catch {
      return null;
    }
  }

  // ==== Dispatcher ====
  const extractors = {
    "mp4upload.com": extractMp4Upload,
    "uqload.to": extractUqload,
    "dood": extractDoodStream,
    "streamwish": extractStreamwish,
    "videa.hu": extractVidea,
    "vidmoly.to": extractVidmoly,
    "vk.com": extractVk,
    "voe.sx": extractVoe,
  };

  for (const host in extractors) {
    if (url.includes(host)) {
      return await extractors[host](url);
    }
  }

  return null;
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
