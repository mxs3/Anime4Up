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

  async function checkServer(serverUrl) {
    try {
      let resp = await httpGet(serverUrl, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } });
      if (resp && (resp.status >= 200 && resp.status < 400)) return true;
      resp = await httpGet(serverUrl, { method: "GET", headers: { "User-Agent": "Mozilla/5.0" } });
      return resp && (resp.status >= 200 && resp.status < 400);
    } catch {
      return false;
    }
  }

  // ==== VOE Extractor ====
  function voeRot13(str) {
    return str.replace(/[a-zA-Z]/g, function (c) {
      return String.fromCharCode(
        (c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26
      );
    });
  }
  function voeRemovePatterns(str) {
    const patterns = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];
    let result = str;
    for (const pat of patterns) result = result.split(pat).join("");
    return result;
  }
  function voeBase64Decode(str) {
    if (typeof atob === "function") return atob(str);
    return Buffer.from(str, "base64").toString("utf-8");
  }
  function voeShiftChars(str, shift) {
    return str.split("").map(c => String.fromCharCode(c.charCodeAt(0) - shift)).join("");
  }
  async function extractVoe(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    const jsonScriptMatch = html.match(
      /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (!jsonScriptMatch) return null;
    let data;
    try {
      data = JSON.parse(jsonScriptMatch[1].trim());
    } catch {
      return null;
    }
    if (!Array.isArray(data) || typeof data[0] !== "string") return null;
    let step1 = voeRot13(data[0]);
    let step2 = voeRemovePatterns(step1);
    let step3 = voeBase64Decode(step2);
    let step4 = voeShiftChars(step3, 3);
    let step5 = step4.split("").reverse().join("");
    let step6 = voeBase64Decode(step5);
    let result;
    try {
      result = JSON.parse(step6);
    } catch {
      return null;
    }
    if (result && typeof result === "object") {
      return (
        result.direct_access_url ||
        (result.source || []).map(s => s.direct_access_url).find(u => u && u.startsWith("http"))
      );
    }
    return null;
  }

  // ==== Other Extractors ====
  async function extractMp4upload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/player\.src\(\{\s*file\s*:\s*["']([^"']+)["']/i);
    if (match) return normalizeUrl(match[1], embedUrl);
    const found = html.match(/https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*/i);
    if (found) return normalizeUrl(found[0], embedUrl);
    return null;
  }

  async function extractUqload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const headers = { Referer: embedUrl, Origin: "https://uqload.net", "User-Agent": "Mozilla/5.0" };
    const res = await httpGet(embedUrl, { headers });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/sources:\s*\[\s*["']([^"']+\.mp4[^"']*)["']/i);
    if (match) return normalizeUrl(match[1], embedUrl);
    const found = html.match(/https?:\/\/[^"']+\.mp4[^"']*/i);
    if (found) return normalizeUrl(found[0], embedUrl);
    return null;
  }

  async function extractDoodstream(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    const md5Match = html.match(/\/pass_md5\/([a-zA-Z0-9\/\-_]+)/i);
    if (!md5Match) {
      const f = html.match(/https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*/i);
      if (f) return normalizeUrl(f[0], embedUrl);
      return null;
    }
    const md5Path = md5Match[1];
    const domain = embedUrl.match(/^https?:\/\/([^\/]+)/i)[1];
    const passRes = await httpGet(`https://${domain}/pass_md5/${md5Path}`, {
      headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" },
    });
    if (!passRes) return null;
    const tokenUrl = (await passRes.text()).trim();
    return normalizeUrl(tokenUrl, embedUrl);
  }

  async function extractSendvid(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: "https://sendvid.com/", "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/file:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
    if (match) return normalizeUrl(match[1], embedUrl);
    const found = html.match(/https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*/i);
    if (found) return normalizeUrl(found[0], embedUrl);
    return null;
  }

  // ==== Main ====
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const anchorRe = /<a\b[^>]*\bdata-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const providers = [];
    const seen = new Set();

    let match;
    while ((match = anchorRe.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(match[2] || match[3] || "", url);
      let title = (match[4] || rawUrl).trim();
      const titleLower = title.toLowerCase();
      if (seen.has(rawUrl)) continue;
      if (/mega|max|dailymotion/.test(titleLower)) continue;
      seen.add(rawUrl);
      providers.push({ rawUrl, title });
    }

    if (providers.length === 0) {
      return JSON.stringify({ streams: [] });
    }

    const streams = [];
    for (const prov of providers) {
      const u = prov.rawUrl.toLowerCase();
      if (!(await checkServer(prov.rawUrl))) continue;

      let direct = null;
      if (/voe\.sx/.test(u)) {
        direct = await extractVoe(prov.rawUrl);
      } else if (/mp4upload/.test(u)) {
        direct = await extractMp4upload(prov.rawUrl);
      } else if (/uqload/.test(u)) {
        direct = await extractUqload(prov.rawUrl);
      } else if (/dood/.test(u)) {
        direct = await extractDoodstream(prov.rawUrl);
      } else if (/sendvid/.test(u)) {
        direct = await extractSendvid(prov.rawUrl);
      }

      if (direct) {
        streams.push({
          title: prov.title,
          streamUrl: direct,
          headers: { Referer: prov.rawUrl, "User-Agent": "Mozilla/5.0" },
        });
      }
    }

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
