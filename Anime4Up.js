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

  // ==== VOE Extractor (simple + robust fallback) ====
  async function extractVoe(embedUrl) {
    try {
      // prefer httpGet if present
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
      if (!res) return null;
      const html = await res.text();

      // 1) direct property
      let m = html.match(/"direct_access_url"\s*:\s*"([^"]+)"/i);
      if (m && m[1]) return m[1].replace(/\\\//g, "/");

      // 2) JSON <script type="application/json"> ... </script>
      let jsonScript = html.match(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
      if (jsonScript && jsonScript[1]) {
        try {
          const parsed = JSON.parse(jsonScript[1].trim());
          if (parsed && typeof parsed === "object") {
            if (parsed.direct_access_url) return parsed.direct_access_url;
            if (Array.isArray(parsed.source)) {
              for (const s of parsed.source) if (s.direct_access_url) return s.direct_access_url;
            }
          }
        } catch (e) { /* ignore */ }
      }

      // 3) fallback: any mp4 / m3u8
      const any = html.match(/https?:\/\/[^\s"'<>]+(?:m3u8|mp4)[^"'<>]*/i);
      if (any) return any[0].replace(/\\\//g, "/");

      return null;
    } catch (e) {
      console.log("extractVoe error:", e);
      return null;
    }
  }

  // ==== Videa Extractor ====
  async function extractVidea(embedUrl) {
    try {
      const res = await httpGet(embedUrl, {
        headers: {
          Referer: embedUrl,
          "User-Agent": "Mozilla/5.0"
        }
      });
      if (!res) return null;

      const text = await res.text();

      // direct static links (common case)
      const matches = [...text.matchAll(/https:\/\/videa\.hu\/static\/(\d+p)\/[^\s"']+/g)];
      if (matches.length > 0) {
        return matches.map(m => ({
          quality: m[1],
          url: m[0],
          type: "mp4"
        }));
      }

      // fallback: big base64 block (if present) -> try atob decode and re-run regex
      const b64Match = text.match(/([A-Za-z0-9+/=]{100,})/);
      if (b64Match) {
        try {
          const b64 = b64Match[1];
          let decoded = null;
          try { decoded = (typeof atob === "function") ? atob(b64) : Buffer.from(b64, "base64").toString("utf-8"); } catch(e){}
          if (decoded) {
            const staticMatches = [...decoded.matchAll(/https:\/\/videa\.hu\/static\/(\d+p)\/[^\s"']+/g)];
            if (staticMatches.length > 0) {
              return staticMatches.map(m => ({
                quality: m[1],
                url: m[0],
                type: "mp4"
              }));
            }
          }
        } catch (e) {
          console.log("Videa decode error:", e);
        }
      }

      return null;
    } catch (err) {
      console.log("Videa extractor error:", err);
      return null;
    }
  }

// ==== DoodStream / Vide0 Extractor (سورا متوافق + الجودة أو اسم السيرفر) ====
async function extractDoodstream(embedUrl) {
  try {
    function randomStr(len) {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      let result = "";
      for (let i = 0; i < len; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
      return result;
    }

    // fetch embed page
    const pageRes = await httpGet(embedUrl, { headers: { "Referer": embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return null;
    const html = await pageRes.text();

    // extract /pass_md5 path
    const md5Match = html.match(/\/pass_md5\/[a-z0-9\/\-_\.]+/i);

    // direct links fallback
    let streams = [];
    const directMatches = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi)];
    for (const m of directMatches) {
      const url = normalizeUrl(m[1], embedUrl);
      const title = m[2].trim();
      if (url) streams.push({ title, streamUrl: url, type: "mp4", headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" }, server: "DoodStream" });
    }

    if (!md5Match) {
      if (streams.length) return streams;
      const direct = html.match(/https?:\/\/[^\s"'<>]+(?:m3u8|mp4)[^"'<>]*/i);
      return direct ? [ { title: "DoodStream", streamUrl: normalizeUrl(direct[0], embedUrl), type: "mp4", headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" }, server: "DoodStream" } ] : null;
    }

    // domain extraction
    const domainMatch = embedUrl.match(/https?:\/\/([^/]+)/i);
    if (!domainMatch) return null;
    const domain = domainMatch[1];

    // fetch pass_md5
    const md5Path = md5Match[0];
    const passUrl = `https://${domain}${md5Path}`;
    const passRes = await httpGet(passUrl, { headers: { "Referer": embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!passRes) return null;
    const tokenPart = (await passRes.text()).trim();
    if (!tokenPart) return null;

    // build stream url
    const token = md5Path.split("/").pop();
    const expiry = Date.now();
    const random = randomStr(10);
    const streamUrl = `${tokenPart}${random}?token=${token}&expiry=${expiry}`;

    // استخدم أي اسم جودة موجود في الصفحة (SD, HD, FHD) أو النص الموجود جنب اللينك
    const qMatches = [...html.matchAll(/\b(SD|HD|FHD)\b/gi)];
    const qualities = qMatches.length ? qMatches.map(m => m[0].toUpperCase()) : [];

    if (qualities.length) {
      // لو فيه أكتر من جودة، نرجع كل واحدة كـ stream منفصل
      qualities.forEach(q => streams.push({ title: q, streamUrl, type: "mp4", headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" }, server: "DoodStream" }));
    } else {
      // لو مفيش جودة مكتوبة، نرجع اللينك زي ما هو مع اسمه
      streams.push({ title: "DoodStream", streamUrl, type: "mp4", headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" }, server: "DoodStream" });
    }

    return streams.length ? streams : null;

  } catch (err) {
    console.log("extractDoodstream error:", err);
    return null;
  }
}

  // ==== Dailymotion Extractor (simple) ====
  async function extractDailymotion(embedUrl) {
    try {
      const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
      if (!res) return null;
      const html = await res.text();

      // try HLS or progressive links present in page
      const hls = html.match(/"stream_h264_hls_url"\s*:\s*"([^"]+)"/i) || html.match(/"hls"\s*:\s*"([^"]+)"/i);
      if (hls && hls[1]) return normalizeUrl(hls[1].replace(/\\\//g, "/"), embedUrl);

      // try progressive mp4
      const mp4 = html.match(/"progressive_url"\s*:\s*"([^"]+)"/i) || html.match(/https?:\/\/[^"']+\.mp4[^"']*/i);
      if (mp4 && mp4[1]) return normalizeUrl(mp4[1].replace(/\\\//g, "/"), embedUrl);

      return null;
    } catch (e) {
      console.log("extractDailymotion error:", e);
      return null;
    }
  }

  // ==== Main ====
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    // gather provider links (data-ep-url anchors used by your system)
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

    // if anchors not present, also try iframe srcs as backup
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

      if (/voe/.test(u)) direct = await extractVoe(prov.rawUrl);
      else if (/mp4upload/.test(u)) direct = await extractMp4upload(prov.rawUrl);
      else if (/uqload/.test(u)) direct = await extractUqload(prov.rawUrl);
      else if (/(dood|vide0\.net|doodstream|dood\.watch|dood\.so)/.test(u)) direct = await extractDoodstream(prov.rawUrl);
      else if (/sendvid/.test(u)) direct = await extractSendvid(prov.rawUrl);
      else if (/videa/.test(u)) direct = await extractVidea(prov.rawUrl);
      else if (/dailymotion\.com|dai\.ly/.test(u)) direct = await extractDailymotion(prov.rawUrl);

      if (!direct) return null;

      // normalize returned form: either array of streams or a single url/string
      if (Array.isArray(direct)) {
        return direct.map(d => ({
          title: `${prov.title} [${d.quality || "auto"}]`,
          streamUrl: d.url,
          type: d.type || "mp4",
          headers: { Referer: prov.rawUrl, "User-Agent": "Mozilla/5.0" }
        }));
      }

      // direct string -> single stream
      return { title: prov.title, streamUrl: direct, headers: { Referer: prov.rawUrl, "User-Agent": "Mozilla/5.0" } };
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

class Unbaser {
    constructor(base) {
        this.ALPHABET = {
            62: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
            95: "' !\"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'",
        };
        this.dictionary = {};
        this.base = base;
        if (36 < base && base < 62) {
            this.ALPHABET[base] = this.ALPHABET[base] ||
                this.ALPHABET[62].substr(0, base);
        }
        if (2 <= base && base <= 36) {
            this.unbase = (value) => parseInt(value, base);
        }
        else {
            try {
                [...this.ALPHABET[base]].forEach((cipher, index) => {
                    this.dictionary[cipher] = index;
                });
            }
            catch (er) {
                throw Error("Unsupported base encoding.");
            }
            this.unbase = this._dictunbaser;
        }
    }
    _dictunbaser(value) {
        let ret = 0;
        [...value].reverse().forEach((cipher, index) => {
            ret = ret + ((Math.pow(this.base, index)) * this.dictionary[cipher]);
        });
        return ret;
    }
}

function detect(source) {
    return source.replace(" ", "").startsWith("eval(function(p,a,c,k,e,");
}

function unpack(source) {
    let { payload, symtab, radix, count } = _filterargs(source);
    if (count != symtab.length) {
        throw Error("Malformed p.a.c.k.e.r. symtab.");
    }
    let unbase;
    try {
        unbase = new Unbaser(radix);
    }
    catch (e) {
        throw Error("Unknown p.a.c.k.e.r. encoding.");
