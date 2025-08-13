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

    // لو already protocol-relative
    if (raw.startsWith("//")) return "https:" + raw;

    // حاول استعمال واجهة URL لو ممكن (يدير relative paths بشكل صحيح)
    try {
      if (base) {
        return new URL(raw, base).href;
      } else {
        // لو الرابط يبدأ بـ / أو ./ أو ../ أو بدون بروتوكول، new URL يحتاج أساس؛ إذا لم يُعطَ، اتبع المنطق البسيط:
        if (raw.startsWith("/")) return "https://" + raw.replace(/^\/+/, "");
        if (/^[a-z0-9_\-\.]+\//i.test(raw)) return "https://" + raw; // اسم دومين بدون بروتوكول
        if (/^https?:\/\//i.test(raw)) return raw;
        return "https://" + raw;
      }
    } catch {
      // fallback بسيط
      if (/^https?:\/\//i.test(raw)) return raw;
      return raw.startsWith("/") ? ("https://" + raw.replace(/^\/+/, "")) : ("https://" + raw);
    }
  }

  // ==== smarter checkServer: HEAD ثم GET، ونقبل redirect/status < 400 كـ alive ====
  async function checkServer(serverUrl) {
    try {
      // جرب HEAD أولاً
      let resp = null;
      try {
        resp = await httpGet(serverUrl, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } });
        if (resp && (resp.status >= 200 && resp.status < 400)) return true;
      } catch {}
      // إذا فشل أو رجع redirect/403... جرب GET كاحتياط
      try {
        resp = await httpGet(serverUrl, { method: "GET", headers: { "User-Agent": "Mozilla/5.0" } });
        if (resp && (resp.status >= 200 && resp.status < 400)) return true;
      } catch {}
      return false;
    } catch {
      return false;
    }
  }

  // ==== atob fallback ====
  function safeAtob(s) {
    if (typeof atob === "function") return atob(s);
    try {
      return Buffer.from(s, "base64").toString("utf-8");
    } catch {
      return "";
    }
  }

  // ==== unpackEval (Dean Edwards P.A.C.K.E.R. unpacker) ====
  function unpackEval(packed) {
    if (!packed || typeof packed !== "string") return null;
    // detect pattern
    const pAcker = /eval\(function\(p,a,c,k,e,(?:r|d)\)\s*\{([\s\S]+?)\}\)\)/;
    if (!pAcker.test(packed)) return null;

    try {
      // simple approach: attempt to extract the inner packed args and run a lightweight unpack
      // Note: full JS evaluation isn't safe here; instead apply a common unpack algorithm used for Dean Edwards p,a,c,k,e,d
      const payloadMatch = packed.match(/eval\(function\(p,a,c,k,e,(?:r|d)\)\{([\s\S]+)\}\)\(([\s\S]+)\)/);
      if (!payloadMatch) return null;

      // Extracting the argument string (the (...) at the end)
      const argsMatch = packed.match(/\)\((\s*'[^']+'|\s*"[^"]+"|\s*[^)]+)\)\s*;?\s*$/);
      // Fallback: find the last parentheses content
      let argsStr = null;
      const lastParen = packed.lastIndexOf(")");
      const opener = packed.indexOf("(", packed.indexOf("eval"));
      if (opener >= 0 && lastParen > opener) {
        argsStr = packed.substring(opener + 1, lastParen);
      }

      // As a simpler but effective heuristic: replace common escaped sequences and search for urls
      let cleaned = packed
        .replace(/\\x([0-9A-Fa-f]{2})/g, function (_, g) {
          return String.fromCharCode(parseInt(g, 16));
        })
        .replace(/\\u0?([0-9A-Fa-f]{4})/g, function (_, g) {
          return String.fromCharCode(parseInt(g, 16));
        })
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\//g, "/");

      // sometimes packed contains base64 segments
      const b64Matches = cleaned.match(/([A-Za-z0-9\-_]{20,}={0,2})/g) || [];
      for (const b of b64Matches) {
        try {
          const dec = safeAtob(b);
          if (dec && /https?:\/\//.test(dec)) cleaned += "\n" + dec;
        } catch {}
      }

      return cleaned;
    } catch (e) {
      return null;
    }
  }

  // ==== Extractors ====
  async function extractMp4upload(embedUrl) {
    const res = await soraFetch(embedUrl, { headers: { Referer: embedUrl } });
    const html = await res.text();
    const match = html.match(/player\.src\(\{\s*type:\s*['"]video\/mp4['"],\s*src:\s*['"]([^'"]+)['"]/);
    if (!match) return [];
    return [{ url: match[1], quality: 'Auto' }];
}

  async function extractDoodstream(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) {
      console.log("No response from doodstream server");
      return null;
    }
    const html = await res.text();

    // حاول نمط pass_md5 القديم أو مسارات مماثلة
    let md5PathMatch = html.match(/\/pass_md5\/([a-zA-Z0-9\/\-_\.]+)['"]/i) || html.match(/pass_md5=([a-zA-Z0-9\/\-_\.]+)/i);
    if (!md5PathMatch) {
      // fallback: ابحث عن أي mp4 أو m3u8
      const found = html.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
      if (found && found[0]) return normalizeUrl(found[0], embedUrl);
      console.log("No md5 path found in doodstream HTML");
      return null;
    }
    const md5Path = md5PathMatch[1].replace(/['"]/g, "");
    const streamDomainMatch = embedUrl.match(/^https?:\/\/([^\/]+)/i);
    if (!streamDomainMatch) {
      console.log("Invalid doodstream URL format");
      return null;
    }
    const streamDomain = streamDomainMatch[1];
    const token = md5Path.substring(md5Path.lastIndexOf("/") + 1);
    const expiryTimestamp = new Date().valueOf();
    const random = randomStr(10);

    // حاول استدعاء endpoint pass_md5
    const passResponse = await httpGet(`https://${streamDomain}/pass_md5/${md5Path}`, {
      headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" },
    });
    if (!passResponse) {
      // fallback: حاول مسار آخر أو استخراج مباشر
      const f2 = html.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
      if (f2 && f2[0]) return normalizeUrl(f2[0], embedUrl);
      console.log("No response from doodstream pass_md5");
      return null;
    }
    const responseData = await passResponse.text();
    // responseData قد يكون رابط مباشر أو جزء منه
    const videoUrlCandidate = responseData.trim();
    let videoUrl = videoUrlCandidate;
    if (!/https?:\/\//i.test(videoUrlCandidate)) {
      videoUrl = `${videoUrlCandidate}${random}?token=${token}&expiry=${expiryTimestamp}`;
    } else {
      // لو الرابط كامل، ألحق باراميتر أحيانًا
      videoUrl = `${videoUrlCandidate}${videoUrlCandidate.includes("?") ? "&" : "?"}token=${token}&expiry=${expiryTimestamp}`;
    }
    console.log("DoodStream Stream URL: " + videoUrl);
    return normalizeUrl(videoUrl, embedUrl);
  }

  function randomStr(length) {
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }

  async function extractVoe(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const res = await httpGet(embedUrl, { headers: { Referer: embedUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) {
      console.log("No response from voe server");
      return null;
    }
    const html = await res.text();

    // محاولة JSON application embedded
    const jsonScriptMatch = html.match(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (jsonScriptMatch) {
      const obfuscatedJson = jsonScriptMatch[1].trim();
      try {
        const data = JSON.parse(obfuscatedJson);
        if (Array.isArray(data) && typeof data[0] === "string") {
          // المحاولات القديمة لفك الشيفرة
          try {
            let obfuscatedString = data[0];
            let step1 = voeRot13(obfuscatedString);
            let step2 = voeRemovePatterns(step1);
            let step3 = safeAtob(step2);
            let step4 = voeShiftChars(step3, 3);
            let step5 = step4.split("").reverse().join("");
            let step6 = safeAtob(step5);
            let result = JSON.parse(step6);
            if (result) {
              const streamUrl =
                result.direct_access_url ||
                (result.source && result.source.map(s => s.direct_access_url).find(u => u && /^https?:\/\//.test(u)));
              if (streamUrl) return normalizeUrl(streamUrl, embedUrl);
            }
          } catch {
            // ادامه fallback
          }
        }
      } catch (e) {
        console.log("Invalid JSON in voe extractor:", e.message);
      }
    }

    // fallback: بحث مباشر في الصفحة عن mp4/m3u8
    const direct = html.match(/https?:\/\/[^"'<>\s]+(?:\.m3u8|\.mp4)[^"'<>\s]*/i);
    if (direct && direct[0]) return normalizeUrl(direct[0], embedUrl);

    console.log("No stream URL found in voe decoded JSON or page");
    return null;
  }

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
    for (const pat of patterns) {
      result = result.split(pat).join("");
    }
    return result;
  }

  function voeShiftChars(str, shift) {
    return str
      .split("")
      .map((c) => String.fromCharCode(c.charCodeAt(0) - shift))
      .join("");
  }

  async function extractUqload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const headers = { Referer: embedUrl, Origin: "https://uqload.net", "User-Agent": "Mozilla/5.0" };
    const res = await httpGet(embedUrl, { headers });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/sources:\s*\[\s*["']([^"']+\.mp4[^"']*)["']\s*\]/i);
    if (match && match[1]) return normalizeUrl(match[1], embedUrl);

    // بعض الصفحات تستخدم Clappr.sources أو player config
    const match2 = html.match(/sources\s*=\s*\[["']([^"']+\.mp4[^"']*)["']\]/i);
    if (match2 && match2[1]) return normalizeUrl(match2[1], embedUrl);

    // fallback: بحث عام
    const f = html.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
    if (f && f[0]) return normalizeUrl(f[0], embedUrl);

    return null;
  }

  async function extractYourupload(embedUrl) {
    embedUrl = normalizeUrl(embedUrl);
    const headers = { Referer: "https://www.yourupload.com/", "User-Agent": "Mozilla/5.0" };
    const res = await httpGet(embedUrl, { headers });
    if (!res) return null;
    const html = await res.text();
    const match = html.match(/file:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i);
    if (match && match[1]) return normalizeUrl(match[1], embedUrl);

    // fallback generic
    const f = html.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
    if (f && f[0]) return normalizeUrl(f[0], embedUrl);

    return null;
  }

  async function extractFilemoon(html, baseUrl) {
    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["'][^>]*><\/iframe>/i);
    if (!iframeMatch) return null;
    const iframeUrl = normalizeUrl(iframeMatch[1], baseUrl);
    const res = await httpGet(iframeUrl, { headers: { Referer: baseUrl, "User-Agent": "Mozilla/5.0" } });
    if (!res) return null;
    const iframeHtml = await res.text();

    // حاول نكشف eval-packed scripts ثم نبحث داخلها
    const evalMatch = iframeHtml.match(/eval\(function\(p,a,c,k,e,(?:r|d)\)\{[\s\S]+?\}\)\([^\)]*\)/i);
    if (evalMatch) {
      const unpacked = unpackEval(evalMatch[0]);
      if (unpacked) {
        const m3u8Match = unpacked.match(/https?:\/\/[^"']+master\.m3u8[^"']*/i) || unpacked.match(/https?:\/\/[^"']+\.m3u8[^"']*/i);
        if (m3u8Match) return normalizeUrl(m3u8Match[0], iframeUrl);

        const mp4Match = unpacked.match(/https?:\/\/[^"']+\.mp4[^"']*/i);
        if (mp4Match) return normalizeUrl(mp4Match[0], iframeUrl);
      }
    }

    // fallback: بحث عام في iframeHtml
    const found = iframeHtml.match(/https?:\/\/[^"'<>\s]+(?:master\.m3u8|\.m3u8|\.mp4)[^"'<>\s]*/i);
    if (found && found[0]) return normalizeUrl(found[0], iframeUrl);

    return null;
  }

  // ==== Main ====
  try {
    const pageRes = await httpGet(url, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
    if (!pageRes) return JSON.stringify({ streams: [] });
    const pageHtml = await pageRes.text();

    const anchorRe = /<a\b[^>]*\bdata-ep-url\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const iframeRe = /<iframe[^>]+src=(?:(['"])(.*?)\1|([^\s>]+))/gi;

    const blockedKeywords = ["mega", "megamax", "dailymotion"];
    const providers = [];
    const seen = new Set();

    let match;
    while ((match = anchorRe.exec(pageHtml)) !== null) {
      const rawUrl = normalizeUrl(match[2] || match[3] || "", url);
      let title = (match[4] || rawUrl).replace(/\s+/g, " ").trim();
      const titleLower = title.toLowerCase();
      const rawUrlLower = rawUrl.toLowerCase();

      if (seen.has(rawUrl)) continue;
      if (blockedKeywords.some((kw) => titleLower.includes(kw) || rawUrlLower.includes(kw))) continue;

      seen.add(rawUrl);
      providers.push({ rawUrl, title });
    }

    if (providers.length === 0) {
      let ifrMatch;
      while ((ifrMatch = iframeRe.exec(pageHtml)) !== null) {
        const rawUrl = normalizeUrl(ifrMatch[2] || ifrMatch[3] || "", url);
        const rawUrlLower = rawUrl.toLowerCase();
        if (blockedKeywords.some((kw) => rawUrlLower.includes(kw))) continue;
        providers.push({ rawUrl, title: "iframe" });
        break;
      }
    }

    // إضافة الروابط المباشرة للاختبار (سيبها، بتساعد في debugging)
    providers.push(
      { rawUrl: "https://www.mp4upload.com/embed-djqtega0cr5v.html", title: "mp4upload" },
      { rawUrl: "https://voe.sx/e/oip0zptl2ng7", title: "voe" },
      { rawUrl: "https://d-s.io/e/5p6mtck1aw8r", title: "doodstream" }
    );

    if (providers.length === 0) return JSON.stringify({ streams: [] });

    const streams = [];
    for (const prov of providers) {
      const u = prov.rawUrl.toLowerCase();

      if (blockedKeywords.some((kw) => u.includes(kw))) continue;

      // لا نعتمد على HEAD-only check بعد الآن — checkServer أجرت تحسينات داخلية
      const isServerAlive = await checkServer(prov.rawUrl);
      if (!isServerAlive) {
        console.log(`السيرفر ${prov.rawUrl} غير متاح، يتم تخطيه`);
        continue;
      }

      let direct = null;
      if (/mp4upload\.com/i.test(u)) {
        direct = await extractMp4upload(prov.rawUrl);
      } else if (/uqload/i.test(u)) {
        direct = await extractUqload(prov.rawUrl);
      } else if (/yourupload/i.test(u)) {
        direct = await extractYourupload(prov.rawUrl);
      } else if (/doodstream|d-s\.io|dood/i.test(u)) {
        direct = await extractDoodstream(prov.rawUrl);
      } else if (/voe\.sx|voe\//i.test(u)) {
        direct = await extractVoe(prov.rawUrl);
      } else if (/filemoon/i.test(u)) {
        direct = await extractFilemoon(pageHtml, url);
      }

      if (!direct) {
        try {
          const r = await httpGet(prov.rawUrl, { headers: { Referer: url, "User-Agent": "Mozilla/5.0" } });
          if (r) {
            const txt = await r.text();
            const found = txt.match(/https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*/i) || txt.match(/https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/i);
            if (found && found[0]) direct = normalizeUrl(found[0], prov.rawUrl);
          }
        } catch {}
      }

      if (direct) {
        streams.push({
          title: prov.title,
          streamUrl: direct,
          headers: { Referer: prov.rawUrl, "User-Agent": "Mozilla/5.0" },
        });
      } else {
        streams.push({
          title: prov.title + " (embed)",
          streamUrl: prov.rawUrl,
          headers: { Referer: url, "User-Agent": "Mozilla/5.0" },
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
