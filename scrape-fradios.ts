// scrape-fradios.ts — roda no GitHub Actions (Deno)
// Raspa TODAS as listas do FRadios e grava UM arquivo criptografado (AES-256-GCM): fradios.enc
//
// Uso: SITE_URL= PLAYLISTS_KEY=<base64 32 bytes> \
//      deno run --allow-net --allow-write --allow-env=SITE_URL,PLAYLISTS_KEY,FAMOUS_EMAIL,FAMOUS_PASSWORD scrape-fradios.ts

import { encrypt } from "./crypto.ts";

const BASE = (Deno.env.get("SITE_URL") ?? "").trim().replace(/\/+$/, "");
const KEY = (Deno.env.get("PLAYLISTS_KEY") ?? "").trim();
// Opcionais: só usados se o FRadios não abrir sem login
const EMAIL = (Deno.env.get("FAMOUS_EMAIL") ?? "").trim();
const PASS = (Deno.env.get("FAMOUS_PASSWORD") ?? "").trim();

const OUT_FILE = "fradios.enc";
const CONCURRENCY = 2;
const PAUSE_MS = 250;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const SECTIONS = [
  { q: "r=daily", group: "Global", emoji: "📅", name: "Daily Spins" },
  { q: "r=overall", group: "Global", emoji: "📊", name: "Overall Songs" },
  { q: "r=mediabase", group: "Global", emoji: "🏆", name: "All-Time Mediabase" },

  { q: "r=africaradios", group: "Regiões", emoji: "🌍", name: "África" },
  { q: "r=asiaradios", group: "Regiões", emoji: "🌏", name: "Ásia" },
  { q: "r=europeradios", group: "Regiões", emoji: "🌍", name: "Europa" },
  { q: "r=latinradios", group: "Regiões", emoji: "🌎", name: "América Latina" },
  { q: "r=northamericaradios", group: "Regiões", emoji: "🌎", name: "América do Norte" },
  { q: "r=oceaniaradios", group: "Regiões", emoji: "🌏", name: "Oceania" },

  { q: "r=australiaradios", group: "Países", emoji: "🇦🇺", name: "Austrália" },
  { q: "r=brazilradios", group: "Países", emoji: "🇧🇷", name: "Brasil" },
  { q: "r=canadaradios", group: "Países", emoji: "🇨🇦", name: "Canadá" },
  { q: "r=chinaradios", group: "Países", emoji: "🇨🇳", name: "China" },
  { q: "r=franceradios", group: "Países", emoji: "🇫🇷", name: "França" },
  { q: "r=germanyradios", group: "Países", emoji: "🇩🇪", name: "Alemanha" },
  { q: "r=italyradios", group: "Países", emoji: "🇮🇹", name: "Itália" },
  { q: "r=japanradios", group: "Países", emoji: "🇯🇵", name: "Japão" },
  { q: "r=southkorearadios", group: "Países", emoji: "🇰🇷", name: "Coreia do Sul" }, // (sic) o site escreve assim
  { q: "r=ukradios", group: "Países", emoji: "🇬🇧", name: "Reino Unido" },
  { q: "r=usradios", group: "Países", emoji: "🇺🇸", name: "EUA" },

  { q: "g=popradios", group: "Gêneros", emoji: "🎤", name: "Pop" },
  { q: "g=rockradios", group: "Gêneros", emoji: "🎸", name: "Rock" },
  { q: "g=rbradios", group: "Gêneros", emoji: "🎵", name: "R&B" },
  { q: "g=alternativeradios", group: "Gêneros", emoji: "🎵", name: "Alternative" },
  { q: "g=hiphopradios", group: "Gêneros", emoji: "🎵", name: "Hip-Hop/Rap" },
  { q: "g=danceradios", group: "Gêneros", emoji: "🎵", name: "Dance" },
  { q: "g=variousradios", group: "Gêneros", emoji: "🎵", name: "Various" },
  { q: "g=latingenreradios", group: "Gêneros", emoji: "🎵", name: "Latin (gênero)" },
  { q: "g=kpopradios", group: "Gêneros", emoji: "🎵", name: "K-Pop/J-Pop" },
];

// ---------------- util ----------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeHtml(s: string): string {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}
const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");

const jar: Record<string, string> = {};
function mergeCookies(res: Response) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

async function fetchText(url: string, tries = 3): Promise<string> {
  let lastErr = "";
  for (let i = 0; i < tries; i++) {
    try {
      const headers: Record<string, string> = { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" };
      if (Object.keys(jar).length) headers.Cookie = cookieHeader();
      const res = await fetch(url, { headers });
      mergeCookies(res);
      if (!res.ok) throw new Error("status " + res.status);
      return await res.text();
    } catch (e) {
      lastErr = (e as Error).message;
      console.log(`⚠️ falha (${i + 1}/${tries}) ${url}: ${lastErr}`);
      await sleep(800 * (i + 1));
    }
  }
  throw new Error(`não consegui baixar ${url}: ${lastErr}`);
}

async function login() {
  const h1 = await fetch(`${BASE}/`, { headers: { "User-Agent": UA } });
  mergeCookies(h1);
  await h1.text();
  const res = await fetch(`${BASE}/login.php`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE,
      Referer: BASE + "/",
      Cookie: cookieHeader(),
    },
    body: new URLSearchParams({ email: EMAIL, password: PASS, login: "ENTRAR" }).toString(),
  });
  mergeCookies(res);
  await res.text().catch(() => "");
}

// ---------------- parser ----------------
// Linha compacta: p=posição, i=id do trabalho, t=título, a=artistas [{s:slug,n:nome,f:1 se feat}],
// m=movimento ("+1","-3","=","NEW" ou ""), s=spins, d=variação (se houver), x=1 se [IMPACTO]
// Parser do layout novo (novembro/2026): ol.fr-lista > li.fr-row.
// Mantem as chaves compactas consumidas pelo Worker: p,i,t,a,m,s,d,x.
const textOnly = (html: string) => decodeHtml(stripTags(html)).replace(/\s+/g, " ").trim();
const parseInteger = (s: string): number => {
  const m = s.match(/[+-]?[\d.,]+/);
  if (!m) return 0;
  const raw = m[0];
  // No site, pontos e virgulas em contagens sao separadores de milhar.
  return (raw.startsWith("-") ? -1 : 1) * Number(raw.replace(/[^\d]/g, ""));
};

export function parseSection(html: string) {
  const stamp = textOnly(html.match(/<span\b[^>]*class=["'][^"']*\bfr-atual\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? html.match(/class=["'][^"']*fr-atualiz[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] ?? "");
  const rows: Record<string, unknown>[] = [];
  // Captura apenas o bloco da lista de rankings, evitando menus e outras listas.
  const list = html.match(/<ol\b[^>]*class=["'][^"']*\bfr-lista\b[^"']*["'][^>]*>([\s\S]*?)<\/ol>/i)?.[1] ?? "";
  for (const hit of list.matchAll(/<li\b[^>]*class=["'][^"']*\bfr-row\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    const row = hit[1];
    const posHtml = row.match(/<div\b[^>]*class=["'][^"']*\bfr-pos\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
    const pos = Number(textOnly(posHtml.match(/<b[^>]*>([\s\S]*?)<\/b>/i)?.[1] ?? ""));
    const titleLink = row.match(/<a\b[^>]*class=["'][^"']*\bfr-titulo\b[^"']*["'][^>]*href=["'][^"']*\/trabalho\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
      ?? row.match(/<a\b[^>]*href=["'][^"']*\/trabalho\/(\d+)[^"']*["'][^>]*class=["'][^"']*\bfr-titulo\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!pos || !titleLink) continue;
    const sub = row.match(/<div\b[^>]*class=["'][^"']*\bfr-sub\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
    const artists: { s: string; n: string; f?: 1 }[] = [];
    const featAt = sub.search(/\bfeat\.?\b/i);
    for (const artist of sub.matchAll(/<a\b[^>]*href=["'][^"']*\/artist\/([^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const item: { s: string; n: string; f?: 1 } = { s: artist[1].trim(), n: textOnly(artist[2]) };
      if (featAt >= 0 && artist.index !== undefined && artist.index > featAt) item.f = 1;
      artists.push(item);
    }
    const movementMatch = row.match(/<span\b[^>]*class=["']([^"']*\bfr-mov\b[^"']*)["'][^>]*>([\s\S]*?)<\/span>/i);
    const movementRaw = textOnly(movementMatch?.[2] ?? "");
    const movement = movementMatch?.[1].includes("is-up") ? `+${parseInteger(movementRaw)}`
      : movementMatch?.[1].includes("is-down") ? `-${parseInteger(movementRaw)}`
      : movementRaw;
    const value = row.match(/<div\b[^>]*class=["'][^"']*\bfr-valor\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
    const mainValue = value.split(/<small\b|<span\b/i)[0];
    const delta = value.match(/<span\b[^>]*class=["'][^"']*\bfr-delta\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
    const item: Record<string, unknown> = {
      p: pos, i: titleLink[1], t: textOnly(titleLink[2]), a: artists,
      m: movement, s: parseInteger(textOnly(mainValue)),
    };
    if (delta !== undefined) item.d = parseInteger(textOnly(delta));
    if (/\bIMPACTO\b/i.test(row)) item.x = 1;
    rows.push(item);
  }
  return { stamp, rows };
}

// ---------------- execução ----------------
async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

async function main() {
  if (!/^https?:\/\//i.test(BASE)) {
    console.error("❌ SITE_URL ausente ou inválido");
    Deno.exit(1);
  }
  if (!KEY) {
    console.error("❌ PLAYLISTS_KEY ausente");
    Deno.exit(1);
  }

  // abre sem login; se a página não vier com a tabela, tenta logar
  const first = SECTIONS[0];
  let html = await fetchText(`${BASE}/fradios?${first.q}`);
  if (!parseSection(html).rows.length) {
    if (!EMAIL || !PASS) {
      console.error("❌ FRadios não abriu sem login e FAMOUS_EMAIL/FAMOUS_PASSWORD não estão nos secrets do GitHub");
      Deno.exit(1);
    }
    console.log("🔑 FRadios exigiu login, entrando...");
    await login();
    html = await fetchText(`${BASE}/fradios?${first.q}`);
    if (!parseSection(html).rows.length) {
      console.error("❌ mesmo logado a página não trouxe a tabela, abortando");
      Deno.exit(1);
    }
  }

  const failed: string[] = [];
  const results = await pool(SECTIONS, CONCURRENCY, async (sec) => {
    try {
      const page = sec.q === first.q ? html : await fetchText(`${BASE}/fradios?${sec.q}`);
      const parsed = parseSection(page);
      if (!parsed.rows.length) throw new Error("página sem linhas (formato mudou?)");
      await sleep(PAUSE_MS);
      console.log(`  ✓ ${sec.name}: ${parsed.rows.length} linhas — ${parsed.stamp}`);
      return { ...sec, ...parsed };
    } catch (e) {
      console.log(`  ✗ ${sec.name}: ${(e as Error).message}`);
      failed.push(sec.name);
      return null;
    }
  });

  const ok = results.filter(Boolean);
  if (failed.length > SECTIONS.length * 0.2) {
    console.error(`❌ ${failed.length}/${SECTIONS.length} listas falharam, abortando sem gravar`);
    Deno.exit(1);
  }

  const data = { updatedAt: new Date().toISOString(), count: ok.length, failed, sections: ok };
  const enc = await encrypt(JSON.stringify(data), KEY);
  await Deno.writeTextFile(OUT_FILE, enc);
  console.log(`✅ ${OUT_FILE} gravado: ${ok.length} listas, ${failed.length} falharam (${enc.length} bytes)`);
}

if (import.meta.main) {
  await main();
}
