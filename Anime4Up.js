async function searchResults(keyword) {
  try {
    const url = `https://4p.jguris.shop/?search_param=animes&s=${encodeURIComponent(keyword)}`;
    const res = await fetchv2(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://4p.jguris.shop/'
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
  async function httpGet(u, opts = {}) {
    try {
      if (typeof fetchv2 === 'function') {
        return await fetchv2(u, opts.headers || {}, opts.method || 'GET', opts.body || null);
      } else {
        return await fetch(u, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body || null });
      }
    } catch (e) {
      try {
        return await fetch(u, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body || null });
      } catch {
        return null;
      }
    }
  }

  function normalizeUrl(raw, base = '') {
    if (!raw) return raw;
    raw = String(raw).trim();
    if (raw.startsWith('//')) return 'https:' + raw;
    if (raw.startsWith('/')) {
      if (!base) return 'https://' + raw.replace(/^\/+/, '');
      return base.replace(/\/$/, '') + raw;
    }
    if (!/^https?:\/\//i.test(raw)) return 'https://' + raw;
    return raw;
  }

  // ====== Extractors ======

  async function filemoonExtractor(html, refUrl = null) {
    // extract iframe URL
    const regex = /<iframe[^>]+src="([^"]+)"[^>]*><\/iframe>/;
    const match = html.match(regex);
    if (!match) return null;
    const iframeUrl = normalizeUrl(match[1], refUrl);

    const iframeResponse = await httpGet(iframeUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": refUrl || '',
        "Accept": "text/html"
      }
    });
    if (!iframeResponse) return null;
    const iframeHtml = await iframeResponse.text();

    // Extract eval-packed script with m3u8
    const evalScriptMatch = iframeHtml.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]+?\)\)/);
    if (!evalScriptMatch) return null;

    const unpackedScript = unpack(evalScriptMatch[0]);
    const m3u8Match = unpackedScript.match(/https?:\/\/[^\s"']+master\.m3u8[^\s"']*/);
    if (m3u8Match) return m3u8Match[0];
    return null;
  }

  // Unpacker function for packed js (p.a.c.k.e.r)
  function unpack(source) {
    // Minimal unpacker from your previous code
    let { payload, symtab, radix, count } = _filterargs(source);
    if (count != symtab.length) throw Error("Malformed p.a.c.k.e.r. symtab.");
    let unbase = new Unbaser(radix);
    function lookup(match) {
      const word = match;
      return radix == 1 ? symtab[parseInt(word)] : symtab[unbase.unbase(word)] || word;
    }
    source = payload.replace(/\b\w+\b/g, lookup);
    return source;
  
    function _filterargs(source) {
      const juicers = [
        /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\), *(\d+), *(.*)\)\)/,
        /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\)/
      ];
      for (const juicer of juicers) {
        const args = juicer.exec(source);
        if (args) {
          try {
            return {
              payload: args[1],
              symtab: args[4].split("|"),
              radix: parseInt(args[2]),
              count: parseInt(args[3]),
            };
          } catch {
            throw Error("Corrupted p.a.c.k.e.r. data.");
          }
        }
      }
      throw Error("Could not parse p.a.c.k.e.r. data.");
    }
  }
  class Unbaser {
    constructor(base) {
      this.ALPHABET = {
        62: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      };
      this.dictionary = {};
      this.base = base;
      if (2 <= base && base <= 36) {
        this.unbase = (value) => parseInt(value, base);
      } else {
        [...this.ALPHABET[base]].forEach((cipher, index) => {
          this.dictionary[cipher] = index;
        });
        this.unbase = this._dictunbaser;
      }
    }
    _dictunbaser(value) {
      let ret = 0;
      [...value].reverse().forEach((cipher, index) => {
        ret += Math.pow(this.base, index) * this.dictionary[cipher];
      });
      return ret;
    }
  }

  async function uqloadExtractor(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const headers = {
      "Referer": embedUrl,
      "Origin": "https://uqload.net"
    };
    const response = await httpGet(embedUrl, { headers });
    if (!response) return null;
    const html = await response.text();
    const match = html.match(/sources:\s*\[\s*"([^"]+\.mp4)"\s*\]/);
    return match ? { url: normalizeUrl(match[1], embedUrl), headers } : null;
  }

  async function youruploadExtractor(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const headers = { "Referer": "https://www.yourupload.com/" };
    const response = await httpGet(embedUrl, { headers });
    if (!response) return null;
    const html = await response.text();
    const match = html.match(/file:\s*['"]([^'"]+\.mp4)['"]/);
    return match ? { url: normalizeUrl(match[1], embedUrl), headers } : null;
  }

  async function voeExtractor(html) {
    // Extract JSON script
    const jsonScriptMatch = html.match(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!jsonScriptMatch) return null;
    const obfuscatedJson = jsonScriptMatch[1].trim();
    let data;
    try {
      data = JSON.parse(obfuscatedJson);
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
    try {
      const result = JSON.parse(step6);
      if (result.direct_access_url) return { url: result.direct_access_url, headers: {} };
      if (result.source && Array.isArray(result.source)) {
        const s = result.source.find(src => src.direct_access_url);
        if (s) return { url: s.direct_access_url, headers: {} };
      }
    } catch {
      return null;
    }
    return null;

    function voeRot13(str) {
      return str.replace(/[a-zA-Z]/g, c => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
      });
    }
    function voeRemovePatterns(str) {
      const patterns = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];
      let res = str;
      for (const p of patterns) res = res.split(p).join("");
      return res;
    }
    function voeBase64Decode(str) {
      if (typeof atob === "function") return atob(str);
      return Buffer.from(str, "base64").toString("utf-8");
    }
    function voeShiftChars(str, shift) {
      return str.split("").map(c => String.fromCharCode(c.charCodeAt(0) - shift)).join("");
    }
  }

  async function doodstreamExtractor(html, url) {
    if (!url) return null;
    const streamDomain = (url.match(/https:\/\/(.*?)\//) || [])[1];
    if (!streamDomain) return null;
    const md5Match = html.match(/'\/pass_md5\/(.*?)'/);
    if (!md5Match) return null;
    const md5Path = md5Match[1];
    const token = md5Path.substring(md5Path.lastIndexOf("/") + 1);
    const expiryTimestamp = Date.now();
    const random = randomStr(10);
    try {
      const passResponse = await httpGet(`https://${streamDomain}/pass_md5/${md5Path}`, { headers: { Referer: url } });
      if (!passResponse) return null;
      const responseData = await passResponse.text();
      const videoUrl = `${responseData}${random}?token=${token}&expiry=${expiryTimestamp}`;
      return { url: videoUrl, headers: { Referer: url } };
    } catch {
      return null;
    }

    function randomStr(length) {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      let res = "";
      for (let i = 0; i < length; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
      return res;
    }
  }

  // ====== Main logic ======
  try {
    const response = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!response) return JSON.stringify({ streams: [] });
    const html = await response.text();

    // Find possible embed URLs or direct links in anchors or iframes
    const anchorRe = /<a\b[^>]*\bhref\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))/gi;
    const iframeRe = /<iframe[^>]+src=(?:(['"])(.*?)\1|([^\s>]+))/gi;

    const candidates = new Set();

    let m;
    while ((m = anchorRe.exec(html)) !== null) {
      const link = normalizeUrl(m[2] || m[3], url);
      if (link) candidates.add(link);
    }
    while ((m = iframeRe.exec(html)) !== null) {
      const link = normalizeUrl(m[2] || m[3], url);
      if (link) candidates.add(link);
    }

    const streams = [];

    for (const link of candidates) {
      let result = null;
      if (/uqload/i.test(link)) {
        result = await uqloadExtractor(link);
      } else if (/yourupload/i.test(link)) {
        result = await youruploadExtractor(link);
      } else if (/voe\.sx/i.test(link)) {
        // For VOE, we need to fetch the page and parse
        try {
          const pageRes = await httpGet(link, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
          if (pageRes) {
            const pageHtml = await pageRes.text();
            result = await voeExtractor(pageHtml);
          }
        } catch {}
      } else if (/doodstream|d-s\.io|dood/i.test(link)) {
        try {
          const pageRes = await httpGet(link, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
          if (pageRes) {
            const pageHtml = await pageRes.text();
            result = await doodstreamExtractor(pageHtml, link);
          }
        } catch {}
      } else if (/filemoon/i.test(link)) {
        try {
          const pageRes = await httpGet(link, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
          if (pageRes) {
            const pageHtml = await pageRes.text();
            result = await filemoonExtractor(pageHtml, link);
            if (result) result = { url: result, headers: { Referer: url } };
          }
        } catch {}
      }

      if (result && result.url) {
        streams.push({
          title: link,
          streamUrl: result.url,
          headers: result.headers || { Referer: url, "User-Agent": "Mozilla/5.0" },
        });
      }
    }

    return JSON.stringify({ streams });
  } catch (err) {
    console.log("extractStreamUrl error:", err);
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
