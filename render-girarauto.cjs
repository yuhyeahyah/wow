const sharp = require('sharp');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createDecipheriv}=require('node:crypto');
const run = promisify(execFile);
const W=1400,H=920,CW=248,CH=348;
const svg = (w,h,body)=>Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);
const xml=s=>String(s??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const clip=(s,n)=>Array.from(String(s||'')).length>n?Array.from(String(s)).slice(0,n-1).join('')+'…':String(s||'');
const mask=svg(CW,CH,`<rect width="${CW}" height="${CH}" rx="15" fill="white"/>`);
const rarity={1:'#a87551',2:'#c2c7d4',3:'#e8be58'};
const token=process.env.TELEGRAM_TOKEN;
async function tg(method, payload) {
  const multipart=payload instanceof FormData;
  let r;
  try {r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:multipart?{}:{'content-type':'application/json'},body:multipart?payload:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});} catch {throw Error(`${method}: falha de rede`);}
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.ok) throw Error(`${method}: HTTP ${r.status} ${j.error_code||''}`);
  return j.result;
}
async function download(card) {
  if(!card.img) return null;
  const info=await tg('getFile',{file_id:card.img});
  if(!info.file_path) return null;
  let res;
  try {res=await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`,{signal:AbortSignal.timeout(18000)});} catch {return null;}
  if(!res.ok) return null;
  const bytes=Buffer.from(await res.arrayBuffer());
  if(bytes.length>20*1024*1024) return null;
  if(card.t!=='a') return bytes;
  // GIF é suportado pelo Sharp; MP4 precisa de um frame estático.
  try {await sharp(bytes).metadata();return bytes;} catch {}
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'card-frame-'));
  try {const f=path.join(dir,'input');const out=path.join(dir,'frame.jpg');await fs.writeFile(f,bytes);await run('ffmpeg',['-hide_banner','-loglevel','error','-i',f,'-frames:v','1','-vf','scale=500:-2','-y',out],{timeout:12000});return await fs.readFile(out);} finally {await fs.rm(dir,{recursive:true,force:true});}
}
async function tile(c,bytes) {
  let img,missing=false;
  try {if(!bytes)throw Error('sem foto');img=await sharp(bytes,{limitInputPixels:40000000}).rotate().resize(CW,CH,{fit:'cover',position:'centre'}).ensureAlpha().png().toBuffer();} catch {missing=true;img=await sharp(svg(CW,CH,`<rect width="248" height="348" fill="#51495e"/><circle cx="124" cy="135" r="52" fill="#665b75"/><text x="124" y="143" text-anchor="middle" fill="#fff" font-size="20" font-family="DejaVu Sans">SEM FOTO</text>`)).png().toBuffer();}
  const name=clip(c.name,42), font=name.length>30?15:name.length>23?18:23;
  const overlay=svg(CW,CH,`<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".88"/></linearGradient></defs><rect x="0" y="230" width="248" height="118" fill="url(#fade)"/><rect x="10" y="10" width="48" height="25" rx="10" fill="${rarity[c.r]||rarity[1]}"/><text x="34" y="28" font-family="DejaVu Sans" font-size="13" font-weight="bold" text-anchor="middle" fill="#29222d">${c.r===3?'III':c.r===2?'II':'I'}</text><text x="13" y="324" font-family="DejaVu Sans" font-size="${font}" font-weight="bold" fill="#fff">${xml(name)}</text><rect x="1.5" y="1.5" width="245" height="345" rx="14" fill="none" stroke="${rarity[c.r]||rarity[1]}" stroke-width="3"/>`);
  const decorated=await sharp(img).composite([{input:overlay}]).png().toBuffer();
  return {buffer:await sharp(decorated).composite([{input:mask,blend:'dest-in'}]).png().toBuffer(),missing};
}
async function render(cards,loader=download) {
  const cache=new Map();
  const images=[];
  for(let start=0;start<cards.length;start+=5) {
    const batch=cards.slice(start,start+5);
    images.push(...await Promise.all(batch.map(async c=>{
      if(!cache.has(c.img)) cache.set(c.img,Promise.resolve().then(()=>loader(c)).catch(()=>null));
      return tile(c,await cache.get(c.img));
    })));
  }
  const rows=Math.ceil(cards.length/5), canvasH=rows===1?508:H;
  const base=await sharp(path.join(__dirname,'girarauto-template.svg')).resize(W,canvasH,{fit:'cover'}).png().toBuffer();
  const layers=[];
  for(let i=0;i<images.length;i++){
    const row=Math.floor(i/5),col=i%5,count=Math.min(5,cards.length-row*5),start=Math.round((W-(count*CW+(count-1)*22))/2);
    layers.push({input:images[i].buffer,left:start+col*(CW+22),top:rows===1?80:83+row*400});
  }
  const buf=await sharp(base).composite(layers).jpeg({quality:87,mozjpeg:true}).toBuffer();
  return {buf,missing:images.filter(x=>x.missing).length};
}
async function main() {
  if(!token)throw Error('TELEGRAM_TOKEN ausente');
  const enc=JSON.parse(process.env.PAYLOAD_ENC||'{}');
  const key=Buffer.from(process.env.PLAYLISTS_KEY||'','base64'), bytes=Buffer.from(enc.data||'','base64');
  if(enc.v!==1||key.length!==32||bytes.length<16)throw Error('Payload criptografado inválido');
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(enc.iv,'base64'));
  decipher.setAuthTag(bytes.subarray(-16));
  const p=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0,-16)),decipher.final()]).toString('utf8'));
  if(!Array.isArray(p.cards)||p.cards.length<1||p.cards.length>10||!Number.isSafeInteger(p.chat_id)||!Number.isSafeInteger(p.message_id))throw Error('Payload inválido');
  try {
    const {buf,missing}=await render(p.cards);
    const f=new FormData();f.set('chat_id',String(p.chat_id));f.set('message_id',String(p.message_id));f.set('media',JSON.stringify({type:'photo',media:'attach://montagem',caption:p.caption,parse_mode:'HTML'}));f.set('reply_markup',JSON.stringify({inline_keyboard:p.buttons}));f.set('montagem',new Blob([buf],{type:'image/jpeg'}),'cartas.jpg');
    await tg('editMessageMedia',f);console.log(`Montagem enviada: ${p.cards.length} cartas; ${missing} sem foto disponível.`);
  } catch(e) {
    // Não deixa botões em uma imagem antiga: a recuperação cria nova mensagem sem cobrar giros.
    const warning=p.caption+'\n⚠️ Falha na montagem. Use /girarresultado para tentar novamente.';
    const b={chat_id:p.chat_id,message_id:p.message_id,parse_mode:'HTML',reply_markup:{inline_keyboard:[]}};
    try {await tg('editMessageText',{...b,text:warning});} catch {try{await tg('editMessageCaption',{...b,caption:'⚠️ Falha ao carregar nova página. Cartas salvas. Use /girarresultado.'});}catch{}}
    throw Error('Não foi possível publicar a montagem.');
  }
}
module.exports={render};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
