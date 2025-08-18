// ---------------- Search Results ----------------
async function searchResults(keyword) {
  try {
    const url = `https://ww.anime4up.rest/?search_param=animes&s=${encodeURIComponent(keyword)}`;
    const html = await (await httpGet(url))?.text();
    if (!html) throw new Error("No response");

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

    return JSON.stringify(results.length ? results : [{ title: 'No results found', href: '', image: '' }]);
  } catch (err) {
    return JSON.stringify([{ title: 'Error', href: '', image: '', error: err.message }]);
  }
}

// ---------------- Anime Details ----------------
async function extractDetails(url) {
  try {
    const html = await (await httpGet(url))?.text();
    if (!html) throw new Error("No response");

    let description = "لا يوجد وصف متاح.";
    let airdate = "غير معروف";
    let aliases = "غير مصنف";

    const descMatch = html.match(/<p class="anime-story">([\s\S]*?)<\/p>/i);
    if (descMatch && descMatch[1].trim()) description = decodeHTMLEntities(descMatch[1].trim());

    const genresMatch = html.match(/<ul class="anime-genres">([\s\S]*?)<\/ul>/i);
    if (genresMatch) {
      const genres = [...genresMatch[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map(m => decodeHTMLEntities(m[1].trim()));
      if (genres.length) aliases = genres.join(", ");
    }

    const airdateMatch = html.match(/<span>\s*بداية العرض:\s*<\/span>\s*(\d{4})/i);
    if (airdateMatch && /^\d{4}$/.test(airdateMatch[1].trim())) airdate = airdateMatch[1].trim();

    return JSON.stringify([{ description, aliases, airdate: `سنة العرض: ${airdate}` }]);
  } catch {
    return JSON.stringify([{ description: "تعذر تحميل الوصف.", aliases: "غير مصنف", airdate: "سنة العرض: غير معروفة" }]);
  }
}

// ---------------- Episodes ----------------
async function extractEpisodes(url) {
  const results = [];
  try {
    const getPage = async (pageUrl) => (await httpGet(pageUrl))?.text();
    const firstHtml = await getPage(url);
    if (!firstHtml) throw new Error("No response");

    const typeMatch = firstHtml.match(/<div class="anime-info"><span>النوع:<\/span>\s*([^<]+)<\/div>/i);
    const type = typeMatch ? typeMatch[1].trim().toLowerCase() : "";
    if (type.includes("movie") || type.includes("فيلم")) return JSON.stringify([{ href: url, number: 1 }]);

    let maxPage = 1;
    const allNums = [...firstHtml.matchAll(/\/page\/(\d+)\//g)].map(m => parseInt(m[1], 10));
    if (allNums.length) maxPage = Math.max(...allNums);

    const pages = Array.from({ length: maxPage }, (_, i) => i === 0 ? url : `${url.replace(/\/$/, "")}/page/${i+1}/`);
    const htmlPages = [];
    for (let i = 0; i < pages.length; i++) {
      htmlPages.push(await getPage(pages[i]));
      if (i % 5 === 0) await sleep(500);
    }

    for (const html of htmlPages) {
      const episodeRegex = /<div class="episodes-card-title">\s*<h3>\s*<a\s+href="([^"]+)">[^<]*الحلقة\s*(\d+)[^<]*<\/a>/gi;
      let epMatch;
      while ((epMatch = episodeRegex.exec(html)) !== null) {
        const episodeUrl = epMatch[1].trim();
        const episodeNumber = parseInt(epMatch[2].trim(), 10);
        if (!isNaN(episodeNumber)) results.push({ href: episodeUrl, number: episodeNumber });
      }
    }

    results.sort((a, b) => a.number - b.number);
    return JSON.stringify(results.length ? results : [{ href: url, number: 1 }]);
  } catch (err) {
    console.log("extractEpisodes error:", err);
    return JSON.stringify([{ href: url, number: 1 }]);
  }
}

// ---------------- Helpers (Sora-ready) ----------------
async function httpGet(url, opts = {}) {
  try {
    const headers = { ...defaultHeaders(url), ...(opts.headers || {}) };
    if (typeof fetchv2 === "function") {
      return await fetchv2(url, headers, opts.method || "GET", opts.body || null);
    }
    return await fetch(url, {
      method: opts.method || "GET",
      headers,
      body: opts.body || null
    });
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultHeaders(referer) {
  return {
    "User-Agent": "Mozilla/5.0",
    Referer: referer || "https://ww.anime4up.rest/"
  };
}

function decodeHTMLEntities(text) {
  const entities = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#039;': "'", '&apos;': "'", '&nbsp;': ' ', '&#39;': "'"
  };
  return text.replace(/&[a-zA-Z0-9#]+;/g, m => entities[m] || m);
}

function normalizeUrl(raw, base = "") {
  if (!raw) return raw;
  raw = String(raw).trim();
  if (raw.startsWith("//")) return "https:" + raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, base || "https://").href;
  } catch {
    return raw.startsWith("/") ? "https://" + raw.replace(/^\/+/, "") : "https://" + raw;
  }
}
