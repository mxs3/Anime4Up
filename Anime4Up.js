async function searchResults(keyword) {
  try {
    const url = `https://4q.4ruhzd.shop/?search_param=animes&s=${encodeURIComponent(keyword)}`;
    const res = await fetchv2(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://4q.4ruhzd.shop/'
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

    const firstHtml = await getPage(url);
    const typeMatch = firstHtml.match(/<div class="anime-info"><span>النوع:<\/span>\s*([^<]+)<\/div>/i);
    const type = typeMatch ? typeMatch[1].trim().toLowerCase() : "";

    if (type.includes("movie") || type.includes("فيلم")) {
      return JSON.stringify([{ href: url, number: 1 }]);
    }

    const paginationRegex = /<a[^>]+href="([^"]+\/page\/\d+\/?)"[^>]*class="page-numbers"/gi;
    const pagesSet = new Set();
    let match;
    while ((match = paginationRegex.exec(firstHtml)) !== null) {
      pagesSet.add(match[1]);
    }

    const pages = Array.from(pagesSet);
    pages.push(url);

    const htmlPages = await Promise.all(pages.map(page => getPage(page)));

    for (const html of htmlPages) {
      const episodeRegex = /<div class="episodes-card-title">\s*<h3>\s*<a\s+href="([^"]+)">[^<]*الحلقة\s*(\d+)[^<]*<\/a>/gi;
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

    results.sort((a, b) => a.number - b.number);

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
      if (hasFetchV2) {
        return await fetchv2(u, opts.headers || {}, opts.method || "GET", opts.body || null);
      }
      return await fetch(u, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body || null });
    } catch {
      try {
        return await fetch(u, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body || null });
      } catch {
        return null;
      }
    }
  }

  const safeTrim = (s) => (s ? String(s).trim() : "");

  function normalizeUrl(raw, base = "") {
    if (!raw) return raw;
    raw = safeTrim(raw);

    if (raw.startsWith("//")) return "https:" + raw;
    if (/^https?:\/\//i.test(raw)) return raw;

    try {
      return new URL(raw, base || "https://").href;
    } catch {
      return raw.startsWith("/") ? "https://" + raw.replace(/^\/+/, "") : "https://" + raw;
    }
  }

  async function checkServer(serverUrl) {
    try {
      let resp = await httpGet(serverUrl, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } });
      if (resp && resp.status < 400) return true;
      resp = await httpGet(serverUrl, { method: "GET", headers: { "User-Agent": "Mozilla/5.0" } });
      return resp && resp.status < 400;
    } catch {
      return false;
    }
  }

  const safeAtob = (s) => {
    if (typeof atob === "function") return atob(s);
    try {
      return Buffer.from(s, "base64").toString("utf-8");
    } catch {
      return "";
    }
  };

  function unpackEval(packed) {
    if (!packed || typeof packed !== "string") return null;
    if (!/eval\(function\(p,a,c,k,e,(?:r|d)\)/.test(packed)) return null;
    try {
      let cleaned = packed
        .replace(/\\x([0-9A-Fa-f]{2})/g, (_, g) => String.fromCharCode(parseInt(g, 16)))
        .replace(/\\u0?([0-9A-Fa-f]{4})/g, (_, g) => String.fromCharCode(parseInt(g, 16)))
        .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\//g, "/");

      (cleaned.match(/([A-Za-z0-9\-_]{20,}={0,2})/g) || []).forEach((b) => {
        try {
          const dec = safeAtob(b);
          if (dec && /https?:\/\//.test(dec)) cleaned += "\n" + dec;
        } catch {}
      });
      return cleaned;
    } catch {
      return null;
    }
  }

  // ==== Extractors ====
  async function extractMp4upload(embedUrl) {
  try {
    const res = await fetch(embedUrl, {
      headers: {
        "Referer": embedUrl,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }
    });
    const html = await res.text();

    // أول محاولة: صيغة src: "https://....mp4"
    let match = html.match(/src:\s*"([^"]+\.mp4)"/);
    if (match && match[1]) {
      return match[1];
    }

    // تاني محاولة: file: "https://....mp4"
    match = html.match(/file:\s*"([^"]+\.mp4)"/);
    if (match && match[1]) {
      return match[1];
    }

    // تالت محاولة: player.src({ file: "..." })
    match = html.match(/player\.src\(\{\s*file:\s*"([^"]+\.mp4)"/);
    if (match && match[1]) {
      return match[1];
    }

    console.log("mp4upload extractor: No direct MP4 found");
    return null;
  } catch (e) {
    console.log("mp4upload extractor error:", e);
    return null;
  }
}

  async function extractDoodstream(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();

    let md5PathMatch = html.match(/\/pass_md5\/([a-zA-Z0-9\/\-_\.]+)['"]/i) || html.match(/pass_md5=([a-zA-Z0-9\/\-_\.]+)/i);
    if (!md5PathMatch) {
      const found = html.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
      return found ? normalizeUrl(found[0], embedUrl) : null;
    }
    const md5Path = md5PathMatch[1].replace(/['"]/g, "");
    const domain = (embedUrl.match(/^https?:\/\/([^\/]+)/i) || [])[1];
    if (!domain) return null;
    const token = md5Path.split("/").pop();
    const expiry = Date.now();

    const passResponse = await httpGet(`https://${domain}/pass_md5/${md5Path}`, {
      headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" },
    });
    if (!passResponse) return null;
    const data = (await passResponse.text()).trim();
    let videoUrl = /https?:\/\//i.test(data) ? data : `${data}${Math.random().toString(36).substring(2, 8)}?token=${token}&expiry=${expiry}`;
    return normalizeUrl(videoUrl, embedUrl);
  }

  const randomStr = (len) => [...Array(len)].map(() => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(Math.random() * 62))).join("");

  async function extractVoe(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();

    const jsonScriptMatch = html.match(/<script[^>]+application\/json[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonScriptMatch) {
      try {
        const data = JSON.parse(jsonScriptMatch[1].trim());
        if (data?.source) {
          const u = data.source.map((s) => s.direct_access_url).find((x) => /^https?:\/\//.test(x));
          if (u) return normalizeUrl(u, embedUrl);
        }
      } catch {}
    }
    const direct = html.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
    return direct ? normalizeUrl(direct[0], embedUrl) : null;
  }

  function voeRot13(str) { return str.replace(/[a-zA-Z]/g, (c) => String.fromCharCode(((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26))); }
  function voeRemovePatterns(str) { return ["@$", "^^", "~@", "%?", "*~", "!!", "#&"].reduce((r, p) => r.split(p).join(""), str); }
  function voeShiftChars(str, shift) { return str.split("").map((c) => String.fromCharCode(c.charCodeAt(0) - shift)).join(""); }

  async function extractUqload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, Origin: "https://uqload.net", "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/sources:\s*\[\s*["']([^"']+\.mp4[^"']*)["']\s*\]/i) ||
                  html.match(/sources\s*=\s*\[["']([^"']+\.mp4[^"']*)["']\]/i) ||
                  html.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
    return match ? normalizeUrl(match[1] || match[0], embedUrl) : null;
  }

  async function extractYourupload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: "https://www.yourupload.com/", "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/file:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i) || html.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
    return match ? normalizeUrl(match[1] || match[0], embedUrl) : null;
  }

  async function extractFilemoon(html, baseUrl) {
    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (!iframeMatch) return null;
    const iframeUrl = normalizeUrl(iframeMatch[1], baseUrl);
    const res = await httpGet(iframeUrl, { headers: { Referer: baseUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const iframeHtml = await res.text();

    const evalMatch = iframeHtml.match(/eval\(function\(p,a,c,k,e,(?:r|d)\)[\s\S]+?\)\([^\)]*\)/i);
    if (evalMatch) {
      const unpacked = unpackEval(evalMatch[0]);
      if (unpacked) {
        const m = unpacked.match(/https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*/i);
        if (m) return normalizeUrl(m[0], iframeUrl);
      }
    }
    const found = iframeHtml.match(/https?:\/\/[^"'<>\s]+\.(?:m3u8|mp4)[^"'<>\s]*/i);
    return found ? normalizeUrl(found[0], iframeUrl) : null;
  }

  // ==== Main ====
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const anchorRe = /<a\b[^>]*data-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const iframeRe = /<iframe[^>]+src=(?:(['"])(.*?)\1|([^\s>]+))/gi;

    const blockedKeywords = ["mega", "megamax", "dailymotion"];
    const providers = [];
    const seen = new Set();

    let match;
    while ((match = anchorRe.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(match[2] || match[3] || "", url);
      let title = (match[4] || rawUrl).replace(/\s+/g, " ").trim();
      if (seen.has(rawUrl)) continue;
      if (blockedKeywords.some((kw) => rawUrl.toLowerCase().includes(kw) || title.toLowerCase().includes(kw))) continue;
      seen.add(rawUrl);
      providers.push({ rawUrl, title });
    }

    if (!providers.length) {
      let ifrMatch;
      while ((ifrMatch = iframeRe.exec(pageHtml)) !== null) {
        const rawUrl = normalizeUrl(ifrMatch[2] || ifrMatch[3] || "", url);
        if (!blockedKeywords.some((kw) => rawUrl.toLowerCase().includes(kw))) {
          providers.push({ rawUrl, title: "iframe" });
          break;
        }
      }
    }

    // Debug providers
    providers.push(
      { rawUrl: "https://www.mp4upload.com/embed-djqtega0cr5v.html", title: "mp4upload" },
      { rawUrl: "https://voe.sx/e/oip0zptl2ng7", title: "voe" },
      { rawUrl: "https://d-s.io/e/5p6mtck1aw8r", title: "doodstream" }
    );

    if (!providers.length) return JSON.stringify({ streams: [] });

    const streams = [];
    for (const prov of providers) {
      if (blockedKeywords.some((kw) => prov.rawUrl.toLowerCase().includes(kw))) continue;
      if (!(await checkServer(prov.rawUrl))) continue;

      let direct = null;
      if (/mp4upload\.com/i.test(prov.rawUrl)) direct = await extractMp4upload(prov.rawUrl);
      else if (/uqload/i.test(prov.rawUrl)) direct = await extractUqload(prov.rawUrl);
      else if (/yourupload/i.test(prov.rawUrl)) direct = await extractYourupload(prov.rawUrl);
      else if (/doodstream|d-s\.io|dood/i.test(prov.rawUrl)) direct = await extractDoodstream(prov.rawUrl);
      else if (/voe\.sx|voe\//i.test(prov.rawUrl)) direct = await extractVoe(prov.rawUrl);
      else if (/filemoon/i.test(prov.rawUrl)) direct = await extractFilemoon(pageHtml, url);

      if (!direct) {
        try {
          const r = await httpGet(prov.rawUrl, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
          if (r) {
            const txt = await r.text();
            const f = txt.match(/https?:\/\/[^"'<>\s]+\.(?:m3u8|mp4)[^"'<>\s]*/i);
            if (f && f[0]) direct = normalizeUrl(f[0], prov.rawUrl);
          }
        } catch {}
      }

      streams.push({
        title: prov.title + (!direct ? " (embed)" : ""),
        streamUrl: direct || prov.rawUrl,
        headers: { Referer: prov.rawUrl, "User-Agent": "Mozilla/5.0" },
      });
    }

    return JSON.stringify({ streams });
  } catch (e) {
    console.log("extractStreamUrl error:", e);
    return JSON.stringify({ streams: [] });
  }
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
