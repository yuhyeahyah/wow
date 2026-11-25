// Node 22+, sem dependências. Um único achievements.enc, AES-256-GCM + gzip por bloco.
import { writeFile, readFile, rename } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
function siteBase() {
 const configured = process.env.SITE_URL?.trim();
 if (!configured) throw Error('SITE_URL ausente: configure o secret no GitHub Actions');
 let url;
 try { url = new URL(configured); } catch { throw Error('SITE_URL inválida: informe a URL completa'); }
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '')) throw Error('SITE_URL deve ser a URL HTTPS da raiz do site, sem credenciais, caminho ou parâmetros');
 return url.origin;
}
const BASE = siteBase();
const UA = 'Mozilla/5.0 (compatible; AchievementsBot/1.0)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tabs = {charts:'Charts', mercados:'Mercados', artistas:'Artistas', premios:'Prêmios', turnes:'Turnês'};
const norm = s => String(s||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().trim();
function decode(s='') { return s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m,k)=>{if(k[0]==='#'){const n=k[1].toLowerCase()==='x'?parseInt(k.slice(2),16):Number(k.slice(1));return n>=0&&n<=0x10ffff?String.fromCodePoint(n):m;}return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[k.toLowerCase()]??m;}); }
const text = s => decode(String(s||'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
function attr(s,k) { const m=String(s||'').match(new RegExp('(?:^|\\s)'+k+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i')); return decode(m?.[1]??m?.[2]??m?.[3]??''); }
const opening = s => String(s||'').match(/^<[^>]*>/)?.[0]||'';
const hasClass=(s,c)=>attr(opening(s),'class').split(/\s+/).includes(c);
function blocks(html, cls, tag='[a-z][\\w-]*') {
 const re=new RegExp(`<(${tag})\\b[^>]*\\bclass=["'][^"']*["'][^>]*>`, 'gi'); const out=[]; let m;
 while((m=re.exec(html))){if(!hasClass(m[0],cls))continue; const token=new RegExp(`<\\/?${m[1]}\\b[^>]*>`, 'gi'); token.lastIndex=re.lastIndex; let d=1,t,end=re.lastIndex; while(d&&(t=token.exec(html))){d+=t[0].startsWith('</')?-1:1;end=token.lastIndex;} if(!d){out.push(html.slice(m.index,end));re.lastIndex=end;}}
 return out;
}
const cl=(s,c)=>blocks(s,c)[0]||'';
const cv=(s,c)=>text(cl(s,c));
const tagText=(s,t)=>text(String(s||'').match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`,'i'))?.[1]);
const anchors=s=>[...String(s||'').matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map(m=>({href:attr(opening(m[0]),'href'),html:m[0],name:text(m[0])}));
function hrefParts(h){try{const u=new URL(h,BASE+'/achievements');if(u.origin!==new URL(BASE).origin)return {};const m=u.pathname.match(/\/(artist|trabalho|turne|tour|turnes|fnation)\/([^/]+)\/?$/i);return m?{kind:m[1].toLowerCase(),id:decodeURIComponent(m[2]),href:u.pathname}:{};}catch{return {};}}
function withoutBadges(s){return String(s||'').replace(/<span\b[^>]*class=["'][^"']*\bac-(?:chip|tag-turne)\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,'');}
function rank(s){const t=text(s);return ({'🥇':1,'🥈':2,'🥉':3})[t]||Number(t.match(/\d+/)?.[0])||null;}
function values(s){return [...String(s).matchAll(/<[a-z][\w-]*\b[^>]*\bdata-tt\s*=[^>]*>/gi)].map(m=>({v:attr(m[0],'data-tt'),u:attr(m[0],'data-tt-sub')}));}
const paramsKey=p=>new URLSearchParams(Object.entries(p).filter(([,v])=>v!==''&&v!=null).sort(([a],[b])=>a.localeCompare(b))).toString();
export function parsePage(html, requested={r:'charts'}) {
 const form=cl(html,'ac-filtros'), hero=cl(html,'ac-hero'), title=cl(html,'ac-tit');
 if(!form||!hero||!title)throw Error('HTML de achievements incompleto (login ou layout alterado)');
 const current={}, selects=[];
 for(const m of form.matchAll(/<input\b[^>]*>/gi)){const n=attr(m[0],'name');if(n&&attr(m[0],'type')==='hidden')current[n]=attr(m[0],'value');}
 for(const m of form.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/gi)){
  const n=attr(opening(m[0]),'name'); if(!n)continue;
  const opts=[...m[0].matchAll(/<option\b[^>]*>[\s\S]*?<\/option>/gi)].map(x=>({v:attr(opening(x[0]),'value'),selected:/\sselected(?:\s|=|>)/i.test(opening(x[0]))}));
  if(opts.length){current[n]=(opts.find(o=>o.selected)||opts[0]).v;selects.push({n,opts});}
 }
 current.r=current.r||requested.r||'charts'; if(!tabs[current.r])throw Error('Seção desconhecida');
 const segments=blocks(form,'ac-seg').map(g=>anchors(g).map(a=>({a,p:Object.fromEntries(new URL(a.href,BASE+'/achievements').searchParams)})));
 // Só parâmetros de controles reais. Ignora defaults de outras abas (ex. award=grammy em Charts).
 const variable=new Set();for(const seg of segments){const ks=new Set(seg.flatMap(x=>Object.keys(x.p)));for(const k of ks)if(new Set(seg.map(x=>x.p[k]??'')).size>1)variable.add(k);}
 for(const seg of segments){const active=seg.find(x=>hasClass(x.a.html,'is-on'));if(active)for(const k of variable)if(k in active.p)current[k]=active.p[k];}
 const allowed=new Set([...Object.keys(current),...variable]);
 const neighbors=[];
 for(const {n,opts} of selects)for(const o of opts){if(o.v===current[n])continue;const p={...current,[n]:o.v};if(n==='lista'){delete p.award;delete p.tp;}neighbors.push(p);}
 for(const seg of segments)for(const {p} of seg){const q={...current};for(const k of allowed){if(k in p)q[k]=p[k];else if(variable.has(k))delete q[k];}neighbors.push(q);}
 const group=tabs[current.r], heading=tagText(title,'h2'), subtitle=tagText(title,'p'); if(!heading)throw Error('Título do ranking ausente');
 const section={q:paramsKey(current),group,heading,subtitle,filters:current,total:values(title),rows:[]};
 // Honorários: ranking agregado e fichas individuais são estruturas distintas.
 if(current.r==='premios'&&current.lista==='honorarios'){
  const honorCredit=raw=>{
   const links=anchors(raw).map(a=>({...a,...hrefParts(a.href)})).filter(a=>a.kind==='artist');
   const ids=new Map();for(const a of links){if(!ids.has(a.id)||a.name)ids.set(a.id,a.name||a.id);}
   return [...ids].map(([s,n])=>({s,n}));
  };
  const top=cl(html,'ac-honra-top');
  for(const raw of blocks(top,'js-item','li')){
   const a=honorCredit(raw), t=tagText(cl(raw,'ac-ht-info'),'b')||a[0]?.n, p=rank(cl(raw,'ac-ht-pos'));
   const total=cl(raw,'ac-ht-total'), v=tagText(total,'b'), u=tagText(total,'small');
   const d=[...cl(raw,'ac-ht-chips').matchAll(/<span\b[^>]*>[\s\S]*?<\/span>/gi)].map(m=>text(m[0])).join(' · ');
   if(!t||!p||!v||!a.length)throw Error('Ranking honorário incompleto');
   section.rows.push({p,t,i:'',tour:'',a,artistText:'',v,u,d,heading:'Artistas com mais prêmios honorários'});
  }
  for(const group of blocks(html,'ac-honra-grupo','section')){
   const award=tagText(group,'h3'); const articles=blocks(group,'js-item','article');
   const header=group.match(/<header\b[^>]*>[\s\S]*?<\/header>/i)?.[0]||'';
   const count=Number(tagText(header,'span').match(/\d+/)?.[0]);
   if(!award||!articles.length||(Number.isFinite(count)&&count!==articles.length))throw Error('Grupo honorário incompleto: '+award);
   for(const raw of articles){
    const a=honorCredit(raw),t=tagText(raw,'b'),year=cv(raw,'ac-honra-ano');
    if(!t||!a.length)throw Error('Prêmio honorário sem título/artista: '+award);
    section.rows.push({p:null,t,i:'',tour:'',a,artistText:'',v:'',u:'',d:year,heading:'Prêmios honorários — '+award});
   }
  }
  if(section.rows.length!==blocks(html,'js-item').length)throw Error('Há itens honorários não reconhecidos');
  if(section.rows.length)return {section,neighbors};
 }
 const candidates=blocks(html,'js-item');
 // Alguns mercados não usam js-item no card externo.
 const items=current.r==='mercados'?(blocks(html,'ac-pais').length?blocks(html,'ac-pais'):candidates):candidates;
 if(current.r==='mercados')section.regions=blocks(html,'ac-reg').map(r=>({text:text(r),values:values(r)}));
 for(const raw of items){
  const pod=hasClass(raw,'ac-pod'), market=hasClass(raw,'ac-pais'), honor=hasClass(raw,'ac-ht-info')||!!cl(raw,'ac-ht-info')||!!cl(raw,'ac-honra-artista');
  const info=cl(raw,pod?'ac-pod-corpo':'ac-item-info')||cl(raw,'ac-ht-info')||raw;
  const all=anchors(raw).map(a=>({...a,...hrefParts(a.href)}));
  const credits=[];for(const a of all.filter(x=>x.kind==='artist')){const old=credits.find(x=>norm(x.s)===norm(a.id));if(!old)credits.push({s:a.id,n:a.name||a.id});else if(a.name)old.n=a.name;}
  const infoLinks=anchors(info).map(a=>({...a,...hrefParts(a.href)}));
  const work=infoLinks.find(x=>x.kind==='trabalho'&&tagText(x.html,'b'))||all.find(x=>x.kind==='trabalho'&&tagText(x.html,'b'))||all.find(x=>x.kind==='trabalho'&&x.name)||all.find(x=>x.kind==='trabalho');
  const tour=infoLinks.find(x=>['tour','turne','turnes','fnation'].includes(x.kind)&&x.name)||all.find(x=>['tour','turne','turnes','fnation'].includes(x.kind)&&x.name)||all.find(x=>['tour','turne','turnes','fnation'].includes(x.kind));
  const main=work||tour; const valBlock=cl(raw,pod?'ac-pod-valor':'ac-valor')||cl(raw,'ac-ht-total');
  let p=rank(cl(raw,pod?'ac-medalha':'ac-pos')||cl(raw,'ac-ht-pos')), name='', detail='', v='', u='', artistText='';
  if(market){const top=cl(raw,'ac-pais-topo'), lead=cl(raw,'ac-pais-n1');const marketRank=rank(tagText(top,'em'));p=1;name=tagText(lead,'b')||work?.name||tagText(top,'b');const tail=tagText(lead,'span');artistText=tail.split('·')[0].trim();const vv=values(lead)[0];v=vv?.v||tail.split('·').slice(1).join('·').trim();u=vv?.u||'';const mv=values(cl(raw,'ac-pais-num'))[0];detail=`${tagText(top,'b')} (mercado #${marketRank||'?'}) • #1 single • ${mv?[mv.v,mv.u].filter(Boolean).join(' · '):cv(raw,'ac-pais-num')}`;}
  else {name=main?text(withoutBadges(tagText(main.html,'b')?main.html:main.name)):tagText(withoutBadges(info),'b')||credits[0]?.n||tagText(raw,'b');
   if(main&&tagText(main.html,'b'))name=tagText(withoutBadges(main.html),'b');
   const vv=values(valBlock)[0]||values(raw)[0];v=vv?.v||text(valBlock);u=vv?.u||'';
   detail=text(info.replace(/<b\b[^>]*>[\s\S]*?<\/b>/i,''));
   if(current.r==='premios'&&current.lista==='albuns'&&!credits.length){artistText=tagText(info,'span');u=u||'troféus';}
   if(honor&&!p){detail=[detail,cv(raw,'ac-honra-ano'),text(raw)].filter(Boolean).join(' • ');}
  }
  if(!name||(!p&&!honor&&!market&&current.r!=='premios'))throw Error('Linha sem nome/posição em '+section.q+': '+text(raw).slice(0,120));
  section.rows.push({p,t:name,i:work?.id||'',tour:tour?.href||'',a:credits,artistText,v,u,d:detail});
 }
 // Não trata o aviso de busca (hidden) como lista vazia de verdade.
 const empty=blocks(html,'ac-vazio').some(x=>!(/\shidden(?:\s|=|>)/i.test(opening(x))));
 if(!section.rows.length&&!empty)throw Error('Nenhuma linha reconhecida em '+section.q);
 return {section,neighbors};
}
const jar=new Map();
function cookies(res){for(const c of res.headers.getSetCookie()){const [pair]=c.split(';');const i=pair.indexOf('=');if(i>0)jar.set(pair.slice(0,i),pair.slice(i+1));}}
async function request(url, options={}) {let err;for(let i=0;i<3;i++){try{await sleep(850);const headers={'User-Agent':UA,'Accept-Language':'pt-BR',...options.headers};if(jar.size)headers.Cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');const r=await fetch(url,{...options,headers,redirect:'manual',signal:AbortSignal.timeout(45000)});cookies(r);if(r.status>=300&&r.status<400){const dest=new URL(r.headers.get('location')||'/',url);if(dest.origin!==new URL(BASE).origin)throw Error('Redirecionamento externo');if(options.method==='POST')return await r.text();throw Error('Redirecionamento: '+dest.pathname);}if(!r.ok){if(r.status===429)await sleep(Math.max(30000,Number(r.headers.get('retry-after')||0)*1000));throw Error('HTTP '+r.status);}return await r.text();}catch(e){err=e;await sleep(1500*(i+1));}}throw err;}
async function login(){if(!process.env.SITE_EMAIL||!process.env.SITE_PASSWORD)throw Error('Configure os secrets de login do site se necessário');await request(BASE+'/');await request(BASE+'/login.php',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:BASE,Referer:BASE+'/'},body:new URLSearchParams({email:process.env.SITE_EMAIL,password:process.env.SITE_PASSWORD,login:'ENTRAR'})});}
// Canonicaliza somente os defaults/filtros observados nas cinco abas.
export function canonical(p){
 const q={...p};
 if(q.r==='charts'){q.tipo ||= 'single';q.met ||= 'vendas';q.esc ||= 'mundo';}
 if(q.r==='mercados'){q.met ||= 'vendas';}
 if(q.r==='artistas'){q.lista ||= 'vendas';if(['vendas','streams'].includes(q.lista))q.esc ||= 'mundo';else {delete q.esc;delete q.ano;}}
 if(q.r==='premios'){q.lista ||= 'premiados';if(q.lista==='award')q.award ||= 'grammy';else delete q.award;if(q.lista!=='premiados')delete q.tp;}
 if(q.r==='turnes')q.lista ||= 'publico';
 return Object.fromEntries(Object.entries(q).filter(([,v])=>v!==''&&v!=null));
}
export function inScope(p,mode,year=String(new Date().getUTCFullYear())){
 if(mode==='completo')return true;
 if(mode!=='rapido')return p.r===mode;
 if(!['charts','artistas'].includes(p.r))return true;
 const q=canonical(p);
 return (!q.esc||q.esc==='mundo')&&(!q.ano||q.ano==='novos'||q.ano===year);
}
async function crawl(mode){
 const todo=[],seen=new Set(),done=new Set(),sections=[],failed=[];
 const add=p=>{p=canonical(p);if(!inScope(p,mode))return;const k=paramsKey(p);if(!seen.has(k)){seen.add(k);todo.push(p);}};
 for(const r of Object.keys(tabs))add({r});
 let first;const initial=todo[0],initialQuery=paramsKey(initial);
 try{first=parsePage(await request(BASE+'/achievements?'+initialQuery),initial);}catch(e){console.log('Tentando login após:',e.message);await login();first=parsePage(await request(BASE+'/achievements?'+initialQuery),initial);}
 for(let i=0;i<todo.length;i++){
  const p=todo[i],q=paramsKey(p);if(done.has(q))continue;
  try{
   const parsed=i===0?first:parsePage(await request(BASE+'/achievements?'+q),p);const s=parsed.section;
   const actual=paramsKey(canonical(s.filters));
   if(actual!==q)throw Error('Filtros retornados diferentes dos solicitados: '+actual+' != '+q);
   if(!done.has(actual)){sections.push(s);done.add(actual);}
   for(const n of parsed.neighbors)add(n);
   if(i%25===0)console.log(`${i+1}/${todo.length}: ${s.heading} (${s.rows.length})`);
  }catch(e){failed.push({q,error:e.message});console.error(q,e.message);if(failed.length>=10)throw Error('10 falhas; abortando sem substituir o enc');}
 }
 if(failed.length)throw Error(`${failed.length} páginas falharam: ${JSON.stringify(failed)}`);
 const expected=Object.keys(tabs).filter(r=>inScope({r},mode));
 if(!expected.every(r=>sections.some(s=>s.filters.r===r)))throw Error('Faltam abas');
 return sections;
}
// O archive já está dentro do formato FAMAC001; não cria arquivo auxiliar.
export async function readArchive(file,keyB64){
 const raw=Buffer.from(keyB64,'base64');if(raw.length!==32)throw Error('PLAYLISTS_KEY precisa ter 32 bytes em base64');
 if(file.length<40||file.subarray(0,8).toString()!=='FAMAC001')throw Error('ENC anterior inválido');
 const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
 const open=async b=>{if(b.length<28)throw Error('Bloco inválido');return JSON.parse(gunzipSync(Buffer.from(await crypto.subtle.decrypt({name:'AES-GCM',iv:b.subarray(0,12)},key,b.subarray(12)))).toString());};
 const len=file.readUInt32BE(8),start=12+len;if(len<28||start>file.length)throw Error('Índice inválido');
 const index=await open(file.subarray(12,start));
 const [off,n]=index.archive||[];if(!Number.isSafeInteger(off)||!Number.isSafeInteger(n)||off<0||n<28||start+off+n>file.length)throw Error('Archive inválido');
 const sections=await open(file.subarray(start+off,start+off+n));
 if(!Array.isArray(sections)||sections.length!==index.count||sections.some(s=>!s.filters||!s.q||!Array.isArray(s.rows)))throw Error('Archive incompleto');
 return {index,sections};
}
// Ordenação canônica: ignora ordem de chaves JSON, preserva ordem de posições.
function stable(x){if(Array.isArray(x))return '['+x.map(stable).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';return JSON.stringify(x);}
export function mergeSections(previous,fetched){
 const base=new Map(previous.map(s=>[paramsKey(canonical(s.filters)),s]));
 const fresh=new Map(fetched.map(s=>[paramsKey(canonical(s.filters)),s]));
 const merged=new Map(base);for(const [k,s] of fresh)merged.set(k,s);
 const sections=structuredClone([...merged.values()]);resolveCredits(sections);
 const stats={novos:0,alterados:0,iguais:0,preservados:0};
 for(const s of sections){const k=paramsKey(canonical(s.filters)),old=base.get(k);if(!old)stats.novos++;else if(stable(old)!==stable(s))stats.alterados++;else if(fresh.has(k))stats.iguais++;else stats.preservados++;}
 return {sections,stats};
}
function resolveCredits(sections){
 const artistNames=new Map(),workCredits=new Map();
 for(const s of sections)for(const r of s.rows)for(const a of r.a){
   for(const n of [norm(a.n),norm(a.s)]){if(!artistNames.has(n))artistNames.set(n,new Set());artistNames.get(n).add(a.s.toLowerCase());}
   if(r.i){if(!workCredits.has(r.i))workCredits.set(r.i,new Map());workCredits.get(r.i).set(a.s.toLowerCase(),a);}
 }
 // Resolve texto sem link pelo ID do próprio trabalho quando já há créditos em Charts.
 // Sem vínculo comprovado, usa correspondência exata de nome/slug; não atribui por substring.
 for(const s of sections)for(const r of s.rows){
   if(!r.a.length&&r.artistText){
     const known=workCredits.get(r.i);if(known?.size)r.a=[...known.values()];
     else {const ids=artistNames.get(norm(r.artistText));if(ids?.size===1)r.a=[{s:[...ids][0],n:r.artistText}];}
   }
 }

 return {artistNames};
}
export async function buildFile(sections, keyB64, updatedAt=new Date().toISOString()){
 const raw=Buffer.from(keyB64,'base64');if(raw.length!==32)throw Error('PLAYLISTS_KEY precisa ter 32 bytes em base64');const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
 const map=new Map();
 const add=(id,label,hit)=>{let o=map.get(id);if(!o){o={name:label,hits:[]};map.set(id,o);}else if(id.startsWith('a:')&&norm(o.name)===norm(id.slice(2))&&norm(label)!==norm(id.slice(2)))o.name=label;o.hits.push(hit);};
 const {artistNames}=resolveCredits(sections);

 for(const s of sections)for(const r of s.rows){const hit={g:s.group,h:r.heading||s.heading,c:[s.subtitle,s.filters.ano==='novos'?'Lançamentos (até 120 dias)':s.filters.ano?'Lançados em '+s.filters.ano:''].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(' · '),q:s.q,p:r.p,t:r.t,i:r.i,v:r.v,u:r.u,d:r.d,a:r.a.map(a=>a.n).join(', ')||r.artistText};if(r.i)add('t:'+r.i,r.t,hit);if(r.tour)add('u:'+r.tour,r.t,hit);const keys=new Set();for(const a of r.a){const id='a:'+a.s.toLowerCase();if(!keys.has(id)){add(id,a.n,hit);keys.add(id);}}if(r.artistText&&!r.a.length){const ids=artistNames.get(norm(r.artistText));if(ids?.size===1)add('a:'+ [...ids][0],r.artistText,hit);else add('n:'+norm(r.artistText),r.artistText,hit);}}
 const seal=async obj=>{const iv=crypto.getRandomValues(new Uint8Array(12));const gz=gzipSync(JSON.stringify(obj));const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,gz);return Buffer.concat([iv,Buffer.from(ct)]);};
 const chunks=[],index={updatedAt,count:sections.length,rows:sections.reduce((n,s)=>n+s.rows.length,0),entries:{}};let off=0;
 for(const [id,obj] of map){const buf=await seal(obj);index.entries[id]=[off,buf.length,obj.name];chunks.push(buf);off+=buf.length;}
 // Arquivo bruto também preserva linhas sem artista/trabalho, totais e filtros.
 const archive=await seal(sections);index.archive=[off,archive.length];chunks.push(archive);
 const encIndex=await seal(index);const header=Buffer.alloc(12);header.write('FAMAC001');header.writeUInt32BE(encIndex.length,8);const result=Buffer.concat([header,encIndex,...chunks]);if(result.length>90*1024*1024)throw Error('Arquivo excedeu 90 MiB; não será enviado ao GitHub');return result;
}
async function main(){
 const key=process.env.PLAYLISTS_KEY;if(!key)throw Error('PLAYLISTS_KEY ausente');
 if(process.argv[2]){const sections=[parsePage(await readFile(process.argv[2],'utf8')).section];const file=await buildFile(sections,key);await writeFile('achievements-test.enc',file);return;}
 let old=null;try{old=await readArchive(await readFile('achievements.enc'),key);}catch(e){if(e.code!=='ENOENT')throw e;}
 let mode=process.env.ACH_MODE||'auto';
 if(mode==='auto')mode=old?'rapido':'completo';
 if(!['rapido','completo',...Object.keys(tabs)].includes(mode))throw Error('Modo inválido: '+mode);
 if(!old&&mode!=='completo')throw Error('Primeira coleta: execute o modo completo ou auto antes de atualizar parcialmente.');
 console.log('Modo: '+mode+' | rankings anteriores: '+(old?.sections.length||0));
 const fetched=await crawl(mode),{sections,stats}=mergeSections(old?.sections||[],fetched);
 console.log('Comparação: '+JSON.stringify(stats)+' | consultados: '+fetched.length+' | base final: '+sections.length);
 if(old&&!stats.novos&&!stats.alterados){console.log('Nenhuma mudança. ENC original preservado, sem novo commit.');return;}
 const file=await buildFile(sections,key);
 await writeFile('achievements.enc.tmp',file);await rename('achievements.enc.tmp','achievements.enc');
 console.log(`OK: ${sections.length} rankings; ${file.length} bytes`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e);process.exitCode=1;});
