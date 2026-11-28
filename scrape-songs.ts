// scrape-songs.ts — roda no GitHub Actions (Deno)
// Raspa todas as regiões do FTunes e grava UM arquivo criptografado (AES-256-GCM): songs.enc
//
// Uso: SITE_URL=https://jogofamous.com PLAYLISTS_KEY=<base64 32 bytes> \
//      deno run --allow-net --allow-write --allow-env=SITE_URL,PLAYLISTS_KEY,FTUNES_REGIONS scrape-songs.ts

import { encrypt } from "./crypto.ts";

const BASE = (Deno.env.get("SITE_URL") ?? "https://jogofamous.com").trim().replace(/\/+$/, "");
const KEY = (Deno.env.get("PLAYLISTS_KEY") ?? "").trim();

const OUT_FILE = "songs.enc";
const PAUSE_MS = 400;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Regions vem do secret FTUNES_REGIONS (JSON)
// Formato: [{"name":"Worldwide","emoji":"🌐","param":"wwsongs"}, ...]
function loadRegions(): { name: string; emoji: string; param: string }[] {
  const raw = (Deno.env.get("FTUNES_REGIONS") ?? "").trim();
  if (!raw) throw new Error("FTUNES_REGIONS não configurado (secret)");
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("vazio");
    return parsed.filter((r) => r && r.param);
  } catch (e) {
    throw new Error("FTUNES_REGIONS inválido: " + (e as Error).message);
  }
}

const REGIONS = loadRegions();

function decodeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchText(url: string, tries = 3): Promise<string> {
  let lastErr = "";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error("status " + res.status);
      return await res.text();
    } catch (e) {
      lastErr = (e as Error).message;
      console.log(`⚠️ falha (${i + 1}/${tries}) ${url}: ${lastErr}`);
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw new Error(`não consegui baixar ${url}: ${lastErr}`);
}

function parseFtunesHtml(html: string, regionParam: string) {
  const items: any[] = [];
  const re = /<li class="tn-row[^"]*"[^>]*data-busca="([^"]*)"[\s\S]*?<div class="tn-pos"><b>(\d+)<\/b>(?:<span class="tn-mov[^"]*">([^<]*)<\/span>)?[\s\S]*?<a class="tn-capa[^"]*" href="\.\.\/trabalho\/(\d+)"[\s\S]*?<a class="tn-titulo" href="\.\.\/trabalho\/\4"><span>([^<]*)<\/span><\/a>[\s\S]*?<div class="tn-sub">([\s\S]*?)<\/div>[\s\S]*?<div class="tn-pts"><b>([\d.]+)<\/b>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const artistRaw = m[6].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    items.push({
      region: regionParam,
      busca: decodeHtml(m[1]),
      pos: Number(m[2]),
      mov: (m[3] || "").trim(),
      id: m[4],
      title: decodeHtml(m[5]).trim(),
      artist: decodeHtml(artistRaw),
      pts: m[7],
    });
  }
  return items;
}

async function main() {
  if (!KEY) throw new Error("PLAYLISTS_KEY não configurada");

  const all: any[] = [];
  for (const r of REGIONS) {
    const url = `${BASE}/ftunes?p=${r.param}`;
    try {
      const html = await fetchText(url);
      const items = parseFtunesHtml(html, r.param);
      all.push(...items);
      console.log(`✅ ${r.param}: ${items.length}`);
    } catch (e) {
      console.log(`❌ ${r.param}: ${(e as Error).message}`);
    }
    await new Promise((res) => setTimeout(res, PAUSE_MS));
  }

  const payload = {
    updated: new Date().toISOString(),
    count: all.length,
    items: all,
  };

  const enc = await encrypt(JSON.stringify(payload), KEY);
  await Deno.writeTextFile(OUT_FILE, enc);
  console.log(`songs.enc escrito: ${all.length} itens`);
}

if (import.meta.main) {
  await main();
}
