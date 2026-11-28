/**
 * proxy.js
 * Node script for GitHub Actions
 * Fetches BR proxies and makes requests
 */

const https = require("https");
const http = require("http");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

const PROXY_SOURCES = [
  "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/by-country/BR.txt",
  "https://raw.githubusercontent.com/maximilianfeix/free-proxy-list/main/countries/br.txt",
];

const TARGET = process.env.SITE_URL || "";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Contas (coloque via secrets no Actions)
const ACCOUNTS = JSON.parse(process.env.ACCOUNTS || "[]");
// Exemplo de secret:
// [{"name":"conta1","user":"email@...","pass":"senha"}]

async function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

async function getBrazilProxies() {
  const proxies = new Set();

  for (const src of PROXY_SOURCES) {
    try {
      const text = await fetchText(src);
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

      for (const line of lines) {
        if (line.startsWith("http://") || line.startsWith("socks4://") || line.startsWith("socks5://")) {
          proxies.add(line);
        } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(line)) {
          // ip:port sem protocolo → tenta como http
          proxies.add(`http://${line}`);
        }
      }
    } catch (e) {
      console.log(`Falha ao baixar ${src}:`, e.message);
    }
  }

  return Array.from(proxies);
}

function createAgent(proxyUrl) {
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  }
  return new HttpsProxyAgent(proxyUrl);
}

async function requestWithProxy(url, proxyUrl, options = {}) {
  const agent = createAgent(proxyUrl);

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: options.method || "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "pt-BR,pt;q=0.9",
          ...(options.headers || {}),
        },
        agent,
        timeout: 15000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
          })
        );
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

async function tryLogin(account, proxyUrl) {
  const loginUrl = `${TARGET}/login.php`;

  // 1. Pega a página de login (pra pegar cookie + token se existir)
  const page = await requestWithProxy(loginUrl, proxyUrl);
  const cookie = (page.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");

  // 2. Faz o POST de login
  const body = new URLSearchParams({
    email: account.user,
    senha: account.pass,
    // ajuste os campos conforme o form real do site
  }).toString();

  const res = await requestWithProxy(loginUrl, proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
      Referer: loginUrl,
    },
    body,
  });

  const ok = res.status === 302 || res.body.includes("logout") || res.body.includes("home.php");
  return { ok, status: res.status, cookie: res.headers["set-cookie"] || cookie };
}

async function main() {
  if (!TARGET) {
    console.log("Secret SITE_URL não definido. Abortando.");
    process.exit(1);
  }

  console.log("Baixando proxies BR...");
  const proxies = await getBrazilProxies();
  console.log(`Encontrados ${proxies.length} proxies`);

  if (!proxies.length) {
    console.log("Nenhum proxy encontrado. Abortando.");
    process.exit(1);
  }

  // Testa alguns proxies
  const testUrl = `${TARGET}/`;
  const working = [];

  for (const p of proxies.slice(0, 30)) {
    try {
      const start = Date.now();
      const res = await requestWithProxy(testUrl, p);
      const ms = Date.now() - start;
      if (res.status === 200 || res.status === 302) {
        console.log(`OK  ${p}  (${ms}ms) status=${res.status}`);
        working.push(p);
      } else {
        console.log(`NO  ${p}  status=${res.status}`);
      }
    } catch (e) {
      console.log(`ERR ${p}  ${e.message}`);
    }
    if (working.length >= 5) break;
  }

  console.log(`\nProxies funcionando: ${working.length}`);

  if (!working.length) {
    console.log("Nenhum proxy respondeu. Tente de novo mais tarde.");
    return;
  }

  // Se tiver contas, tenta login
  if (ACCOUNTS.length) {
    for (const acc of ACCOUNTS) {
      for (const p of working) {
        try {
          console.log(`\nTentando login ${acc.name} via ${p}`);
          const result = await tryLogin(acc, p);
          console.log(result.ok ? "LOGIN OK" : "LOGIN FALHOU", result.status);
          if (result.ok) break;
        } catch (e) {
          console.log("Erro no login:", e.message);
        }
      }
    }
  } else {
    console.log("Nenhuma conta no secret ACCOUNTS. Só testei os proxies.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
