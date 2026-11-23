#!/usr/bin/env node
// Importa trabalhos do Famous direto no cards.enc (criptografado) rodando no GitHub Actions.
//
// O trecho entre os marcadores abaixo foi COPIADO do worker.js (mesmas regras de gênero,
// raridade por peak, categorias e criptografia). Se mudar essas regras no worker,
// regenere este arquivo em vez de editar à mão.
//
// Variáveis de ambiente (o workflow cartas.yml já preenche):
//   IDS             ids dos trabalhos, separados por vírgula
//   CHAT_ID         chat do Telegram que recebe os avisos e onde as capas são enviadas (e apagadas)
//   GITHUB_TOKEN    token do próprio Actions (permissions: contents: write)
//   PLAYLISTS_KEY   mesma chave do Worker
//   TELEGRAM_TOKEN  token do bot

// ===================== INÍCIO DO TRECHO COPIADO DO worker.js =====================

let TELEGRAM_TOKEN = "";

const GH_OWNER = "yuhyeahyah";

const GH_REPO = "wow";

const GH_BRANCH = "main";

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(String(b64).trim()), (c) => c.charCodeAt(0));
}

async function decryptPlaylists(payload, keyB64) {
  try {
    const { iv, data } = JSON.parse(payload);
    const key = await crypto.subtle.importKey("raw", b64ToBytes(keyB64), "AES-GCM", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(iv) }, key, b64ToBytes(data));
    return new TextDecoder().decode(pt);
  } catch (e) {
    throw new Error("falha ao descriptografar (PLAYLISTS_KEY diferente da do GitHub?) " + (e?.message || ""));
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function absUrl(u) {
  if (!u) return "";
  if (u.startsWith("http")) return u;
  return new URL(u, "https://jogofamous.com/").href;
}

async function tgJson(method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({ ok: false, description: "resposta inválida do Telegram" }));
}

async function tgMultipart(method, form) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, { method: "POST", body: form });
  return res.json().catch(() => ({ ok: false, description: "resposta inválida do Telegram" }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function htmlToText(h) {
  return decodeHtml(
    String(h || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchPageText(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" },
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

function parseTrabalhoWiki(html) {
  const title = decodeHtml((html.match(/class="heading wiki-heading"[^>]*>([^<]+)</) || [])[1] || "").trim();
  const descM = html.match(/class="flexbox about">[\s\S]*?<span class="wiki-text">([\s\S]*?)<\/span>/);
  const description = descM ? htmlToText(descM[1]) : "";

  const coverM = html.match(/class="flexbox box-cover image">\s*<img[^>]*\ssrc="([^"]+)"/);
  const typeM = html.match(/class="small type stronger">([^<]+)</);

  const info = [];
  const rowRe = /<div class="flexbox info-row">\s*<span class="att small stronger">([^<]+)<\/span>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const key = decodeHtml(m[1].trim());
    let val;
    if (/^tags$/i.test(key)) {
      val = [...m[2].matchAll(/label-table[^>]*>([^<]+)</g)].map((x) => decodeHtml(x[1].trim())).join(", ");
    } else {
      val = htmlToText(m[2]).replace(/\s*\n\s*/g, " ").replace(/\s+,/g, ",").replace(/,\s*$/, "").trim();
    }
    if (val) info.push({ key, val });
  }

  const secM = html.match(
    /class="flexbox second-section">\s*<span class="heading section-heading">([\s\S]*?)<\/span>[\s\S]*?<div class="scroll song-lyrics"[^>]*>([\s\S]*?)<\/div>/
  );

  return {
    title,
    description,
    cover: coverM ? absUrl(coverM[1]) : "",
    type: typeM ? decodeHtml(typeM[1].trim()) : "",
    info,
    sectionTitle: secM ? htmlToText(secM[1]) : "",
    sectionText: secM ? htmlToText(secM[2]) : "",
  };
}

function parseTrabalhoPage(html) {
  const title = decodeHtml((html.match(/<span class="work-title">([^<]*)</) || [])[1] || "").trim();
  const artistM = html.match(/class="work-artist[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  const artists = artistM ? htmlToText(artistM[1]).replace(/\s+/g, " ").replace(/\s+,/g, ",") : "";
  const genresM = html.match(/class="work-genres">([\s\S]*?)<\/span>/);
  const yearM = html.match(/class="work-year">(\d+)</);
  const tracksNumM = html.match(/class="work-tracks-number small">([^<]+)</);
  const scoreM = html.match(/class="flexbox metacritic"[\s\S]*?class="score">(\d+)</);
  const releaseM = html.match(/class="release-date">([^<]+)</);
  const covers = [
    ...new Set(
      [...html.matchAll(/<div class="tab-pane[^"]*" id="product-[^"]+">\s*<img src="([^"]+)"/g)].map((m) => absUrl(m[1]))
    ),
  ];

  // tracklist
  const tracks = [];
  const tIdx = html.indexOf('class="tracklist-table"');
  if (tIdx !== -1) {
    const tEnd = html.indexOf("</table>", tIdx);
    const tHtml = html.slice(tIdx, tEnd === -1 ? undefined : tEnd);
    for (const row of tHtml.split('<tr tabindex="0">').slice(1)) {
      const pos = row.match(/class="small subtitle pos">\s*(\d+)/);
      const t = row.match(/class="title track[^"]*">\s*<a href="\.\.\/trabalho\/(\d+)">([^<]+)<\/a>/);
      if (!pos || !t) continue;
      const art = row.match(/class="small subtitle artist">([\s\S]*?)<\/span>/);
      const typ = row.match(/class="small subtitle typ">\s*([^<]+)</);
      const str = row.match(/class="small subtitle str">\s*([^<]+)</);
      tracks.push({
        pos: pos[1],
        id: t[1],
        title: decodeHtml(t[2].trim()),
        artists: art ? htmlToText(art[1]).replace(/\s+/g, " ").replace(/\s+,/g, ",") : "",
        type: typ ? typ[1].trim() : "",
        streams: str ? str[1].trim() : "",
      });
    }
  }

  // reviews
  const reviews = [];
  for (const part of html.split('class="card-review"').slice(1)) {
    const name = part.match(/<b class="text-primary">([\s\S]*?)<i\b/);
    const text = part.match(/<p class="card-text">([\s\S]*?)<\/p>/);
    if (!name || !text) continue;
    const score = part.match(/class="fs-3 fw-bolder"[^>]*>\s*(\d+)\s*</);
    const date = part.match(/publicou uma avalia[çc][ãa]o em (\d{2}\/\d{2}\/\d{4})/);
    reviews.push({
      name: htmlToText(name[1]),
      score: score ? score[1] : "",
      date: date ? date[1] : "",
      text: htmlToText(text[1]),
    });
  }

  // comentários
  const comments = [];
  for (const part of html.split('<div class="flexbox comment"').slice(1)) {
    const text = part.match(/class="comment-text small subtitle">([\s\S]*?)<\/span>/);
    if (!text) continue;
    const name = part.match(/class="artist-name title">([\s\S]*?)<\/a>/);
    const slug = part.match(/href="\.\.\/artist\/([^"]+)"/);
    const body = htmlToText(text[1]);
    if (!body) continue;
    comments.push({
      name: (name && htmlToText(name[1])) || (slug ? slug[1] : "Anônimo"),
      text: body,
    });
  }

  return {
    title,
    artists,
    genres: genresM ? htmlToText(genresM[1]).replace(/\s+/g, " ") : "",
    year: yearM ? yearM[1] : "",
    tracksNum: tracksNumM ? tracksNumM[1].trim() : "",
    score: scoreM ? scoreM[1] : "",
    release: releaseM ? releaseM[1].trim() : "",
    covers,
    tracks,
    reviews,
    comments,
  };
}

const CARDS_PATH = "cards.enc";

const CRT_CACHE_MS = 60 * 1000;

const CRT_PEAK_RULES = [
  { max: 1, r: 3 }, // #1 = Lendário
  { max: 10, r: 2 }, // top 10 = Raro
];

const crtRarityFromPeak = (peak) => {
  const p = Number(peak);
  if (!p) return 1;
  const rule = CRT_PEAK_RULES.find((x) => p <= x.max);
  return rule ? rule.r : 1;
};

const CRT_GROUPS = [
  { name: "K-Pop/J-Pop", emoji: "🇰🇷", re: /k-?pop|j-?pop|c-?pop|t-?pop|k-?rock|j-?rock/ },
  { name: "Brasil", emoji: "🇧🇷", re: /mpb|samba|forro|sertanej|funk brasileiro|brega|pagode|axe|bossa/ },
  { name: "Latin", emoji: "💃", re: /latin|reggaeton|bachata|salsa|tango|bolero|regional mexicana/ },
  { name: "Pop", emoji: "🎤", re: /^(pop|art pop|bedroom pop|electropop|hyperpop|teen pop|synthpop|dream pop)$/ },
  { name: "Hip-Hop/R&B", emoji: "🎧", re: /hip.?hop|rap|trap|drill|r&b|rnb|soul|^funk$|afrobeat/ },
  { name: "Dance/Eletrônica", emoji: "⚡", re: /dance|eletr|electr|edm|house|techno|trance|drum|dubstep|disco|garage|jungle/ },
  { name: "Rock", emoji: "🎸", re: /rock|punk|metal|grunge/ },
  { name: "Alternative/Indie", emoji: "🌙", re: /alternativ|indie|experimental|lo-?fi|ambient|industrial|trip hop/ },
  { name: "Pop", emoji: "🎤", re: /pop/ },
];

const CRT_GROUP_OTHERS = { name: "Outros", emoji: "🎼" };

const CRT_GENRE_FIX = {
  anneritchie: "R&B",
  jacob: "R&B",
  nickdiaz: "R&B",
  vito: "R&B",
  ashford: "R&B",
  dahlia: "R&B",
  dallas: "R&B",
  heccy: "R&B",
  effie: "KPOP",
  mariah: "Hip-Hop",
};

const crtGroupGenre = (g) => {
  const n = crtNorm(g);
  return (n && CRT_GROUPS.find((x) => x.re.test(n))) || CRT_GROUP_OTHERS;
};

const crtGenreFor = (slug, ...vals) => vals.find((v) => v && String(v).trim()) || CRT_GENRE_FIX[String(slug || "").toLowerCase()] || "";

const crtNorm = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

let crtCache = null;

let crtCacheAt = 0;

let crtSha = null;

const crtEmpty = () => ({ v: 1, updatedAt: null, nextCard: 1, nextCat: 1, nextSub: 1, cats: [], cards: [] });

const crtApiUrl = () => `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${CARDS_PATH}`;

const crtGhHeaders = (env, accept) => ({
  "User-Agent": "famous-bot",
  Accept: accept,
  ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
});

function crtB64(bytes) {
  let s = "";
  for (let k = 0; k < bytes.length; k += 8192) s += String.fromCharCode(...bytes.subarray(k, k + 8192));
  return btoa(s);
}

async function crtEncrypt(text, keyB64) {
  const key = await crypto.subtle.importKey("raw", b64ToBytes(keyB64), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return JSON.stringify({ v: 1, iv: crtB64(iv), data: crtB64(new Uint8Array(ct)) });
}

async function crtFetchFile(env) {
  if (!env.GITHUB_TOKEN) {
    const r = await fetch(`https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${CARDS_PATH}`, {
      headers: { "User-Agent": "famous-bot" },
    });
    if (r.status === 404) return { text: null, sha: null };
    if (!r.ok) throw new Error("GitHub raw HTTP " + r.status);
    return { text: await r.text(), sha: null };
  }
  const url = `${crtApiUrl()}?ref=${GH_BRANCH}`;
  const r = await fetch(url, { headers: crtGhHeaders(env, "application/vnd.github+json") });
  if (r.status === 404) return { text: null, sha: null };
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const j = await r.json();
  let text = j.content && j.encoding === "base64" ? atob(j.content.replace(/\s/g, "")) : "";
  if (!text) {
    // arquivo > 1 MB: a API não manda o conteúdo no JSON
    const r2 = await fetch(url, { headers: crtGhHeaders(env, "application/vnd.github.raw+json") });
    if (!r2.ok) throw new Error("GitHub raw HTTP " + r2.status);
    text = await r2.text();
  }
  return { text, sha: j.sha };
}

async function crtLoad(env, fresh = false) {
  if (!fresh && crtCache && Date.now() - crtCacheAt < CRT_CACHE_MS) return crtCache;
  if (!env?.PLAYLISTS_KEY) throw new Error("PLAYLISTS_KEY não configurada no Cloudflare");
  const { text, sha } = await crtFetchFile(env);
  const data = text ? JSON.parse(await decryptPlaylists(text, env.PLAYLISTS_KEY)) : crtEmpty();
  crtCache = data;
  crtCacheAt = Date.now();
  crtSha = sha;
  return data;
}

async function crtMutate(env, message, fn) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN não configurado (precisa de Contents: Read and write)");
  for (let t = 0; t < 3; t++) {
    const data = await crtLoad(env, true);
    const sha = crtSha;
    const result = await fn(data);
    data.updatedAt = new Date().toISOString();
    const enc = await crtEncrypt(JSON.stringify(data), env.PLAYLISTS_KEY);
    const res = await fetch(crtApiUrl(), {
      method: "PUT",
      headers: { ...crtGhHeaders(env, "application/vnd.github+json"), "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: btoa(enc), branch: GH_BRANCH, ...(sha ? { sha } : {}) }),
    });
    if ((res.status === 409 || res.status === 422) && t < 2) continue;
    if (!res.ok) throw new Error(`não consegui gravar no GitHub (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    crtSha = j.content?.sha || null;
    crtCache = data;
    crtCacheAt = Date.now();
    return result;
  }
}

async function crtUploadCover(chatId, url, srcId) {
  const grab = async (r) => {
    if (!r?.ok) return null;
    const ph = r.result.photo || [];
    await tgJson("deleteMessage", { chat_id: chatId, message_id: r.result.message_id });
    return ph.length ? ph[ph.length - 1].file_id : null;
  };

  if (!url && srcId) {
    try {
      url = parseTrabalhoWiki(await fetchPageText(`https://jogofamous.com/ajaxpags.php?id=${srcId}&n=wiki`)).cover;
    } catch {}
  }
  if (!url) return null;

  const viaUrl = await grab(await tgJson("sendPhoto", { chat_id: chatId, photo: url, disable_notification: true }));
  if (viaUrl) return viaUrl;

  try {
    const img = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Referer: "https://jogofamous.com/" } });
    if (!img.ok) return null;
    const type = img.headers.get("content-type") || "image/jpeg";
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "jpg";
    const f = new FormData();
    f.set("chat_id", String(chatId));
    f.set("disable_notification", "true");
    f.set("photo", new Blob([await img.arrayBuffer()], { type }), `capa.${ext}`);
    return await grab(await tgMultipart("sendPhoto", f));
  } catch {
    return null;
  }
}

let crtApuracao = false;

async function crtPeakOf(id) {
  try {
    const html = await fetchPageText(`https://jogofamous.com/ajaxpags.php?id=${id}&n=sales`);
    if (/em apura[çc][ãa]o/i.test(html)) {
      crtApuracao = true;
      return undefined;
    }
    const run = [
      ...html.matchAll(
        /<tr[^>]*textcentertable[^>]*>[\s\S]*?<td[^>]*>\d{2}\/\d{2}\/\d{4}<\/td>[\s\S]*?<td[^>]*>\s*<b>#(\d+)<\/b>/gi
      ),
    ].map((m) => parseInt(m[1], 10));
    return run.length ? Math.min(...run) : null;
  } catch {
    return undefined;
  }
}

async function crtCollectFromTrabalho(id) {
  const [w, pg] = await Promise.allSettled([
    fetchPageText(`https://jogofamous.com/ajaxpags.php?id=${id}&n=wiki`),
    fetchPageText(`https://jogofamous.com/trabalho/${id}`),
  ]);
  const wiki = parseTrabalhoWiki(w.status === "fulfilled" ? w.value : "");
  const page = parseTrabalhoPage(pg.status === "fulfilled" ? pg.value : "");
  const title = wiki.title || page.title;
  if (!title) throw new Error(`não achei o trabalho ${id} no site`);
  const slugM = pg.status === "fulfilled" ? pg.value.match(/class="work-artist[^"]*"[^>]*>[\s\S]*?href="\.\.\/artist\/([^"]+)"/) : null;
  return {
    artist: (page.artists || "Desconhecido").split(/,|\sfeat\.|\s&\s/i)[0].trim(),
    slug: slugM ? slugM[1] : "",
    genre: (page.genres || "").split(",")[0].trim(),
    items: [{ src: String(id), title, cover: wiki.cover || page.covers?.[0] || "", tag: wiki.type }],
  };
}

function crtApplyImport(data, info, items, group) {
  let cat = data.cats.find((c) => crtNorm(c.name) === crtNorm(group.name));
  if (!cat) {
    cat = { id: data.nextCat++, name: group.name, emoji: group.emoji, subs: [] };
    data.cats.push(cat);
  }

  // com slug compara pelo slug (tem artistas com o mesmo nome); sem slug, pelo nome
  const mesmo = (x) =>
    x.slug && info.slug ? x.slug.toLowerCase() === info.slug.toLowerCase() : crtNorm(x.name) === crtNorm(info.artist);
  let sub = null;
  let from = null;
  for (const c of data.cats) {
    const found = c.subs.find(mesmo);
    if (found) {
      sub = found;
      from = c;
      break;
    }
  }
  if (sub && from !== cat) {
    from.subs = from.subs.filter((x) => x !== sub);
    cat.subs.push(sub);
    for (const c of data.cards) if (c.sub === sub.id) c.cat = cat.id;
    if (!from.subs.length) data.cats = data.cats.filter((x) => x !== from);
  }
  if (!sub) {
    sub = { id: data.nextSub++, name: info.artist, ...(info.slug ? { slug: info.slug } : {}) };
    cat.subs.push(sub);
  }
  if (info.slug && !sub.slug) sub.slug = info.slug;

  if (info.rank) sub.rank = info.rank; // posição no ranking mundial (aparece no /categorias)
  const out = { added: [], updated: [], cat, artist: info.artist };
  for (const it of items) {
    const known = it.peak !== undefined; // em apuração = só o ranking conta
    const rankR = it.rankR || 1;
    const r = Math.max(known ? crtRarityFromPeak(it.peak) : 1, rankR);
    const ex = data.cards.find((c) => c.src === it.src);
    if (ex) {
      if (!known) ex.r = Math.max(ex.r || 1, rankR);
      if (known) {
        ex.r = r;
        if (it.peak) ex.peak = it.peak;
        delete ex.pend;
      }
      if (!ex.img && it.img) {
        ex.img = it.img;
        ex.t = "p";
      }
      out.updated.push(ex);
      continue;
    }
    const c = { id: data.nextCard++, name: it.title, cat: cat.id, sub: sub.id, r, img: it.img || null, t: "p", src: it.src };
    if (it.peak) c.peak = it.peak;
    if (!known) c.pend = true; // raridade provisória até os charts saírem
    if (it.tag) c.tags = [it.tag];
    data.cards.push(c);
    out.added.push(c);
  }
  return out;
}
// =====================================================================
// FIM DO TRECHO COPIADO DO worker.js — daqui pra baixo é só o roteiro do Actions
// =====================================================================

const env = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, PLAYLISTS_KEY: process.env.PLAYLISTS_KEY };
TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const CHAT = process.env.CHAT_ID ? Number(process.env.CHAT_ID) : null;
const IDS = [...new Set(String(process.env.IDS || "").split(/[^0-9]+/).filter(Boolean))];
const CHUNK = 20; // trabalhos por commit

let progressMsg = null;
async function say(text, edit = false) {
  if (!CHAT) return;
  try {
    if (edit && progressMsg) {
      const r = await tgJson("editMessageText", { chat_id: CHAT, message_id: progressMsg, text, parse_mode: "HTML" });
      if (r.ok || /not modified/i.test(r.description || "")) return;
    }
    const r = await tgJson("sendMessage", { chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true });
    if (edit && r.ok) progressMsg = r.result.message_id;
  } catch {}
}

async function retry(fn, tries = 3) {
  let last;
  for (let t = 0; t < tries; t++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(1500 * (t + 1));
    }
  }
  throw last;
}

async function main() {
  if (!env.PLAYLISTS_KEY) throw new Error("secret PLAYLISTS_KEY não configurado no GitHub");
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN ausente (o workflow precisa de permissions: contents: write)");
  if (!IDS.length) throw new Error("nenhum ID de trabalho recebido");

  console.log(`Importando ${IDS.length} trabalhos...`);
  const st = { novas: 0, atual: 0, pend: 0, semCapa: [], err: [], feitos: 0 };
  const render = (fim) =>
    `${fim ? "✅ <b>Importação pelo GitHub Actions concluída</b>" : "🚀 <b>Importando pelo GitHub Actions</b>"}\n\n` +
    `🎵 Trabalhos: <b>${st.feitos}/${IDS.length}</b>\n🆕 ${st.novas} cartas novas • 🔄 ${st.atual} atualizadas`;
  await say(render(false), true);

  for (let i = 0; i < IDS.length; i += CHUNK) {
    const lote = IDS.slice(i, i + CHUNK);
    const atual = await crtLoad(env, true);
    const prep = [];

    for (const id of lote) {
      try {
        const info = await retry(() => crtCollectFromTrabalho(id));
        const x = info.items[0];
        crtApuracao = false;
        x.peak = await crtPeakOf(x.src);
        if (crtApuracao) st.pend++;
        const old = atual.cards.find((c) => c.src === x.src);
        x.img = old?.img || null;
        if (!x.img && CHAT) {
          x.img = await crtUploadCover(CHAT, x.cover, x.src);
          if (!x.img) {
            await sleep(3000);
            x.img = await crtUploadCover(CHAT, x.cover, x.src);
          }
          await sleep(1100); // Telegram: ~1 mensagem por segundo no mesmo chat
        }
        if (!x.img) st.semCapa.push(id);
        prep.push({ info });
      } catch (e) {
        st.err.push(`${id}: ${String(e?.message || e).slice(0, 80)}`);
      }
    }

    if (prep.length) {
      const res = await crtMutate(env, `cartas: importa trabalhos ${i + 1}-${i + lote.length} (Actions)`, (data) =>
        prep.map((p) => crtApplyImport(data, p.info, p.info.items, crtGroupGenre(crtGenreFor(p.info.slug, p.info.genre))))
      );
      for (const r of res) {
        st.novas += r.added.length;
        st.atual += r.updated.length;
      }
    }
    st.feitos += lote.length;
    console.log(`${st.feitos}/${IDS.length} • +${st.novas} novas • ${st.atual} atualizadas • ${st.err.length} erros`);
    await say(render(false), true);
  }

  let fim = render(true);
  if (st.pend) fim += `\n⏳ ${st.pend} com os charts em apuração (raridade provisória). Depois das 20h de sexta, mande a página de novo que eu atualizo.`;
  if (st.semCapa.length) fim += `\n🖼️❌ ${st.semCapa.length} sem capa (use /setimage id): ${esc(st.semCapa.slice(0, 20).join(", "))}${st.semCapa.length > 20 ? "…" : ""}`;
  if (st.err.length) fim += `\n⚠️ ${st.err.length} com erro:\n${st.err.slice(0, 15).map(esc).join("\n")}${st.err.length > 15 ? "\n…" : ""}\n(mande a página de novo: só entram os que faltam)`;
  fim += `\n\n💡 Rode /reclassificar pra criar as cartas de artista e gravadora.`;
  await say(fim, false);
  console.log("Concluído.");
}

main().catch(async (e) => {
  console.error(e);
  await say(`❌ <b>Importação pelo Actions falhou</b>\n${esc(String(e?.message || e).slice(0, 300))}`);
  process.exit(1);
});
