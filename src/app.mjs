import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIR || './data',
  email: process.env.ADMIN_EMAIL || '',
  password: process.env.ADMIN_PASSWORD || '',
  secret: process.env.SESSION_SECRET || '',
  apiUrl: process.env.ONESENDER_API_URL || '',
  apiKey: process.env.ONESENDER_API_KEY || '',
  starKey: process.env.STARSENDER_DEVICE_API_KEY || '',
  interval: Math.max(15, Number(process.env.SEND_INTERVAL_SECONDS || 30)) * 1000,
};
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [key, value] of Object.entries({ ADMIN_EMAIL: config.email, ADMIN_PASSWORD: config.password, SESSION_SECRET: config.secret, ONESENDER_API_URL: config.apiUrl, ONESENDER_API_KEY: config.apiKey })) {
    if (!value) throw new Error(`Environment variable ${key} wajib diisi`);
  }
  const u = new URL(config.apiUrl);
  if (u.protocol !== 'https:' || !u.pathname.endsWith('/api/v1/messages')) throw new Error('ONESENDER_API_URL harus HTTPS dan berakhir /api/v1/messages');
  if (config.secret.length < 32) throw new Error('SESSION_SECRET minimal 32 karakter');
}

mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'crm.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS contacts (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
 tag TEXT NOT NULL DEFAULT '', consented INTEGER NOT NULL DEFAULT 0,
 opted_out INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS campaigns (
 id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, tag TEXT NOT NULL DEFAULT '',
 provider TEXT NOT NULL DEFAULT 'onesender', scheduled_at TEXT, state TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS deliveries (
 id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
 contact_id INTEGER NOT NULL REFERENCES contacts(id), phone TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(campaign_id, contact_id));
CREATE INDEX IF NOT EXISTS deliveries_queue ON deliveries(state,campaign_id,id);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS throttle (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);`);
if (!db.prepare('PRAGMA table_info(campaigns)').all().some(x=>x.name==='provider')) db.exec("ALTER TABLE campaigns ADD COLUMN provider TEXT NOT NULL DEFAULT 'onesender'");
// A restart during an in-flight HTTP request has an uncertain result: do not repeat it.
db.exec(`UPDATE deliveries SET state='unknown', error='Proses terhenti saat permintaan dikirim; periksa log OneSender' WHERE state='sending';
UPDATE campaigns SET state='paused' WHERE state='running' AND id IN (SELECT campaign_id FROM deliveries WHERE state='unknown');`);

export function normalizePhone(input) {
  let v = String(input || '').trim().replace(/[\s().-]/g, '');
  if (v.startsWith('+')) v = v.slice(1);
  if (v.startsWith('0')) v = '62' + v.slice(1);
  if (!/^[1-9]\d{8,14}$/.test(v)) throw new Error('Nomor harus memakai kode negara, misalnya 628123456789');
  return v;
}
export function parseCsv(input) {
  const rows = []; let row = [], field = '', quoted = false;
  input = String(input).replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') { if (field) throw new Error('Format CSV tidak valid'); quoted = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); if (row.some(x => x.trim())) rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (quoted) throw new Error('Tanda kutip CSV tidak tertutup');
  row.push(field.replace(/\r$/, '')); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hash = v => createHmac('sha256', config.secret).update(v).digest('hex');
const equal = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const passwordHash = v => scryptSync(String(v), 'wa-crm-admin', 64);
function sid(req) { const match = (req.headers.cookie || '').match(/(?:^|;\s*)session=([0-9a-f]{64})/); return match?.[1] || ''; }
function auth(req) {
  const token = sid(req); if (!token) return null;
  return db.prepare('SELECT csrf FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
}
function html(res, title, body, status = 200, session = null, extra = {}) {
  const nav = session ? `<nav><a href="/">Ringkasan</a><a href="/contacts">Kontak</a><a href="/campaigns">Kampanye</a><form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(session.csrf)}"><button>Keluar</button></form></nav>` : '';
  const page = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · WA CRM</title><style>
  :root{font-family:Inter,system-ui,Arial,sans-serif;color:#162823;background:#f6f8f7}*{box-sizing:border-box}body{margin:0}header{background:#fff;border-bottom:1px solid #d9e4df;padding:17px max(calc((100vw - 1100px)/2),24px);display:flex;align-items:center;gap:32px;flex-wrap:wrap}header strong{color:#08784f;font-size:21px}nav{display:flex;align-items:center;gap:20px;flex-wrap:wrap}a{color:#08784f;text-decoration:none}nav a{font-weight:600}main{max-width:1100px;margin:30px auto;padding:0 24px}h1{font-size:27px;margin:0 0 18px}h2{font-size:19px}section,.card{background:white;border:1px solid #dde6e1;border-radius:13px;padding:22px;margin:16px 0}label{display:block;font-size:14px;font-weight:650;margin:15px 0 5px}input,textarea,select{width:100%;max-width:650px;border:1px solid #cbd8d1;border-radius:8px;font:inherit;padding:11px}input[type=checkbox]{width:auto}textarea{min-height:115px}button,.button{display:inline-block;background:#08784f;color:white;border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:650;cursor:pointer;margin:8px 7px 0 0}button.alt{background:#eaf4ef;color:#07573b}.hint{color:#566a61;font-size:14px}.error{color:#a72020}.success{color:#067347}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid #e8eeeb;padding:10px;vertical-align:top}th{color:#54645c}td form{display:inline}td button{padding:6px 9px;font-size:13px}.scroll{overflow:auto}.row{display:flex;gap:16px;flex-wrap:wrap}.row>*{flex:1;min-width:190px}.badge{background:#e7f5ec;color:#075e3d;padding:4px 8px;border-radius:5px}code{white-space:pre-wrap;overflow-wrap:anywhere}.stats{font-size:28px;font-weight:750;color:#08784f}small{color:#687b71}@media(max-width:650px){table{min-width:650px}main{margin:18px auto}}
  </style></head><body><header><strong>WA CRM</strong>${nav}</header><main>${body}</main></body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer', 'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...extra });
  res.end(page);
}
const csrf = s => `<input type="hidden" name="csrf" value="${esc(s.csrf)}">`;
const redirect = (res, url, cookie) => { res.writeHead(303, {location:url, ...(cookie ? {'set-cookie':cookie} : {})}); res.end(); };
const err = (res, message, s, status=400) => html(res, 'Kesalahan', `<h1>Permintaan gagal</h1><section class="error">${esc(message)}</section><p><a href="/">Kembali</a></p>`, status, s);
async function read(req, limit=2_500_000) {
  let chunks=[], size=0; for await (const c of req) { size+=c.length; if(size>limit) throw new Error('Data terlalu besar (maksimum 2,5 MB)'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
const vals = req => new URLSearchParams(req);
const get = (s,k) => String(s.get(k) ?? '').trim();
function contactCount(tag='') { return db.prepare("SELECT count(*) n FROM contacts WHERE consented=1 AND opted_out=0 AND (?='' OR tag=?)").get(tag,tag).n; }
function cleanTag(v) { if (v.length>60) throw new Error('Tag maksimal 60 karakter'); return v; }
function postContact(name, phone, tag, consent, note='') {
  if (!name || name.length>120) throw new Error('Nama wajib diisi, maksimal 120 karakter');
  if (note.length>500) throw new Error('Catatan maksimal 500 karakter');
  phone=normalizePhone(phone); tag=cleanTag(tag);
  db.prepare(`INSERT INTO contacts(name,phone,tag,consented,note) VALUES(?,?,?,?,?)
    ON CONFLICT(phone) DO UPDATE SET name=excluded.name,tag=excluded.tag,
    consented=CASE WHEN contacts.opted_out=1 THEN 0 ELSE excluded.consented END,note=excluded.note`)
    .run(name,phone,tag,consent ? 1:0,note);
}
function renderContacts(res,s,query) {
  const q=String(query||'').slice(0,80);
  const contacts=db.prepare(`SELECT * FROM contacts WHERE name LIKE ? OR phone LIKE ? OR tag LIKE ? ORDER BY id DESC LIMIT 300`).all(...Array(3).fill(`%${q}%`));
  html(res,'Kontak',`<h1>Kontak</h1><p class="hint">Hanya kontak berizin dan belum berhenti berlangganan yang bisa menerima kampanye.</p>
  <section><h2>Tambah / perbarui nomor</h2><form method="post" action="/contacts">${csrf(s)}<div class="row"><div><label>Nama</label><input required maxlength="120" name="name"></div><div><label>Nomor WhatsApp</label><input required name="phone" placeholder="628123456789"></div><div><label>Tag</label><input name="tag" maxlength="60"></div></div><label><input type="checkbox" name="consent" value="yes"> Sudah memberi izin menerima pesan WhatsApp</label><label>Catatan CRM</label><input name="note" maxlength="500"><button>Simpan kontak</button></form></section>
  <section><h2>Impor CSV</h2><p class="hint">Header: name,phone,tag,consent. Simpan CSV sebagai UTF-8. Impor tidak menghapus status opt-out.</p><form method="post" action="/contacts/import">${csrf(s)}<label>Tempel isi CSV</label><textarea required name="csv" placeholder="name,phone,tag,consent&#10;Budi,628123456789,pelanggan,yes"></textarea><button>Impor</button></form></section>
  <section><h2>Daftar kontak (${contacts.length}${contacts.length===300?'+':''})</h2><form method="get"><input name="q" value="${esc(q)}" placeholder="Cari nama, nomor, atau tag"><button>Cari</button></form><div class="scroll"><table><tr><th>Nama</th><th>Nomor</th><th>Tag</th><th>Izin</th><th>Catatan</th><th>Tindakan</th></tr>${contacts.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${esc(c.tag)}</td><td>${c.opted_out?'Berhenti':c.consented?'Ya':'Belum'}</td><td>${esc(c.note)}</td><td><form method="post" action="/contacts/${c.id}/optout">${csrf(s)}<button class="alt">${c.opted_out?'Pulihkan tanpa izin':'Berhenti kirim'}</button></form></td></tr>`).join('')}</table></div></section>`,200,s);
}
function renderCampaigns(res,s) {
  const campaigns=db.prepare(`SELECT c.*, (SELECT count(*) FROM deliveries d WHERE d.campaign_id=c.id) total,
    (SELECT count(*) FROM deliveries d WHERE d.campaign_id=c.id AND d.state='accepted') accepted,
    (SELECT count(*) FROM deliveries d WHERE d.campaign_id=c.id AND d.state='failed') failed,
    (SELECT count(*) FROM deliveries d WHERE d.campaign_id=c.id AND d.state='unknown') unknown
    FROM campaigns c ORDER BY c.id DESC LIMIT 100`).all();
  html(res,'Kampanye',`<h1>Kampanye</h1><section><h2>Buat draf kampanye teks</h2><form method="post" action="/campaigns">${csrf(s)}<label>Judul internal</label><input required maxlength="120" name="title"><label>Pesan</label><textarea required maxlength="3000" name="body" placeholder="Halo {{name}}, ..."></textarea><p class="hint">Variabel tersedia: {{name}}. Kirim hanya kepada penerima yang menyetujui pesan Anda.</p><label>Filter tag (kosong = seluruh kontak berizin)</label><input name="tag" maxlength="60"><label>Jalur pengirim</label><select name="provider"><option value="onesender">OneSender</option>${config.starKey?'<option value="starsender">StarSender V3</option>':''}</select><button>Simpan draf</button></form></section><section><h2>Riwayat</h2><div class="scroll"><table><tr><th>Judul</th><th>Provider</th><th>Status</th><th>Antrean</th><th>Diterima gateway</th><th>Gagal</th><th>Tidak pasti</th></tr>${campaigns.map(c=>`<tr><td><a href="/campaigns/${c.id}">${esc(c.title)}</a></td><td>${esc(c.provider)}</td><td>${esc(c.state)}</td><td>${c.total}</td><td>${c.accepted}</td><td>${c.failed}</td><td>${c.unknown}</td></tr>`).join('')}</table></div></section>`,200,s);
}
function renderCampaign(res,s,id) {
  const c=db.prepare('SELECT * FROM campaigns WHERE id=?').get(id); if(!c) return err(res,'Kampanye tidak ditemukan',s,404);
  const counts=db.prepare('SELECT state,count(*) n FROM deliveries WHERE campaign_id=? GROUP BY state').all(id);
  const deliveries=db.prepare('SELECT d.*,c.name FROM deliveries d JOIN contacts c ON c.id=d.contact_id WHERE d.campaign_id=? ORDER BY d.id DESC LIMIT 300').all(id);
  let actions='';
  if(c.state==='draft') actions=`<p class="hint">Penerima saat ini: ${contactCount(c.tag)}. Daftar penerima dipastikan saat Anda menekan Mulai.</p><form method="post" action="/campaigns/${id}/start">${csrf(s)}<label>Jadwalkan (opsional, WIB / UTC+7)</label><input type="datetime-local" name="scheduled"><button>Mulai / jadwalkan kampanye</button></form>`;
  if(c.state==='running'||c.state==='scheduled') actions=`<form method="post" action="/campaigns/${id}/pause">${csrf(s)}<button class="alt">Jeda kampanye</button></form>`;
  if(c.state==='paused') actions=`<form method="post" action="/campaigns/${id}/resume">${csrf(s)}<label>Provider untuk sisa antrean</label><select name="provider"><option value="onesender" ${c.provider==='onesender'?'selected':''}>OneSender</option>${config.starKey?`<option value="starsender" ${c.provider==='starsender'?'selected':''}>StarSender V3</option>`:''}</select><button>Lanjutkan antrean yang aman</button></form><p class="hint">Periksa hasil terakhir di panel provider sebelum beralih. Item tidak pasti tidak dikirim ulang; hanya antrean yang belum dicoba yang dilanjutkan.</p>`;
  html(res,c.title,`<p><a href="/campaigns">← Kampanye</a></p><h1>${esc(c.title)}</h1><section><p>Status: <span class="badge">${esc(c.state)}</span> · Provider: ${esc(c.provider)} · Tag: ${esc(c.tag||'semua')} · Terjadwal: ${c.scheduled_at?esc(new Date(c.scheduled_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'}))+' WIB':'langsung'}</p><h2>Isi pesan</h2><p><code>${esc(c.body)}</code></p>${actions}</section><section><h2>Hasil</h2><p>${counts.map(x=>`${esc(x.state)}: ${x.n}`).join(' · ')||'Belum ada pengiriman'}</p><p class="hint">“accepted” berarti API provider menerima permintaan; belum berarti diterima/dibaca penerima.</p><div class="scroll"><table><tr><th>Nama</th><th>Nomor</th><th>Status</th><th>Keterangan</th></tr>${deliveries.map(d=>`<tr><td>${esc(d.name)}</td><td>${esc(d.phone)}</td><td>${esc(d.state)}</td><td>${esc(d.error)}</td></tr>`).join('')}</table></div></section>`,200,s);
}
let busy=false, lastSend=0;
export async function sendOne() {
  if(busy || Date.now()-lastSend<config.interval) return;
  db.prepare(`UPDATE deliveries SET state='skipped',error='Izin dicabut atau kontak berhenti berlangganan' WHERE state='queued' AND contact_id IN (SELECT id FROM contacts WHERE consented=0 OR opted_out=1)`).run();
  const job=db.prepare(`SELECT d.id,d.phone,d.campaign_id,c.name,k.body,k.provider FROM deliveries d JOIN campaigns k ON k.id=d.campaign_id JOIN contacts c ON c.id=d.contact_id WHERE d.state='queued' AND k.state='running' AND c.consented=1 AND c.opted_out=0 ORDER BY d.id LIMIT 1`).get();
  if(!job) return;
  busy=true; lastSend=Date.now();
  db.prepare("UPDATE deliveries SET state='sending',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
  try {
    const body=job.body.replaceAll('{{name}}',job.name);
    const star=job.provider==='starsender';
    const endpoint=star?'https://api.starsender.online/api/send':config.apiUrl;
    const payload=star?{messageType:'text',to:job.phone,body}:{to:job.phone,recipient_type:'individual',type:'text',text:{body}};
    const reply=await fetch(endpoint,{method:'POST',headers:{'Authorization':star?config.starKey:`Bearer ${config.apiKey}`,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000),redirect:'error'});
    const response=(await reply.text()).slice(0,1000);
    let parsed={}; try{parsed=JSON.parse(response);}catch{}
    const accepted=star ? (reply.ok && parsed.success===true) : (reply.ok && (String(parsed.code)==='200' || parsed.success===true) && !parsed.error && parsed.success!==false);
    if(accepted) db.prepare("UPDATE deliveries SET state='accepted',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
    else if((reply.status>=400 && reply.status<500) || (reply.ok && (parsed.success===false || parsed.error || (parsed.code && String(parsed.code)!=='200')))) {
      db.prepare("UPDATE deliveries SET state='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(`HTTP ${reply.status}: ${response.slice(0,300)}`,job.id);
      if(reply.status===401||reply.status===403||reply.status===429) db.prepare("UPDATE campaigns SET state='paused' WHERE id=?").run(job.campaign_id);
    } else throw new Error(`Respons tidak pasti (HTTP ${reply.status}): ${response.slice(0,200)}`);
  } catch(e) {
    db.prepare("UPDATE deliveries SET state='unknown',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(String(e.message).slice(0,300),job.id);
    db.prepare("UPDATE campaigns SET state='paused' WHERE id=?").run(job.campaign_id);
  } finally {
    db.prepare(`UPDATE campaigns SET state='done' WHERE id=? AND state='running' AND NOT EXISTS (SELECT 1 FROM deliveries WHERE campaign_id=? AND state IN ('queued','sending'))`).run(job.campaign_id,job.campaign_id);
    busy=false;
  }
}
function housekeeping(){
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  db.prepare('DELETE FROM throttle WHERE until_at<?').run(Date.now());
  db.prepare("UPDATE campaigns SET state='running' WHERE state='scheduled' AND scheduled_at<=?").run(new Date().toISOString());
  db.exec(`UPDATE campaigns SET state='done' WHERE state='running' AND NOT EXISTS (SELECT 1 FROM deliveries WHERE campaign_id=campaigns.id AND state IN ('queued','sending'))`);
  void sendOne().catch(e=>console.error('Worker error:',e.message));
}
export async function handler(req,res) {
  const url=new URL(req.url,'http://localhost'); const pathname=url.pathname;
  if(pathname==='/health'){res.writeHead(200,{'content-type':'text/plain'});return res.end('ok');}
  const s=auth(req);
  if(req.method==='GET' && pathname==='/login') return html(res,'Masuk',`<h1>Masuk</h1><section><form method="post" action="/login"><label>Email</label><input required type="email" name="email"><label>Kata sandi</label><input required type="password" name="password"><button>Masuk</button></form></section>`);
  try {
    if(req.method==='POST' && pathname==='/login') {
      const ip=String(req.socket.remoteAddress||'local'); const key=hash(ip); const record=db.prepare('SELECT * FROM throttle WHERE key=? AND until_at>?').get(key,Date.now());
      if(record?.count>=5) return err(res,'Terlalu banyak percobaan. Tunggu 15 menit.',null,429);
      const v=vals(await read(req,5000));
      const validEmail=equal(get(v,'email').toLowerCase(),config.email.toLowerCase());
      const validPassword=equal(passwordHash(get(v,'password')),passwordHash(config.password));
      if(!validEmail || !validPassword) {
        db.prepare('INSERT INTO throttle(key,count,until_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1,until_at=excluded.until_at').run(key,Date.now()+900000);
        return err(res,'Email atau kata sandi salah',null,401);
      }
      db.prepare('DELETE FROM throttle WHERE key=?').run(key);
      const token=randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions(token_hash,csrf,expires_at) VALUES(?,?,?)').run(hash(token),randomBytes(24).toString('hex'),Date.now()+7*86400000);
      return redirect(res,'/',`session=${token}; HttpOnly; SameSite=Strict; ${process.env.NODE_ENV==='production'?'Secure; ':''}Path=/; Max-Age=604800`);
    }
    if(!s) return redirect(res,'/login');
    if(req.method==='POST') {
      const raw=await read(req); const v=vals(raw);
      if(!equal(get(v,'csrf'),s.csrf)) return err(res,'Token formulir tidak valid. Muat ulang halaman.',s,403);
      if(pathname==='/logout') {db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(sid(req)));return redirect(res,'/login',`session=; HttpOnly; SameSite=Strict; ${process.env.NODE_ENV==='production'?'Secure; ':''}Path=/; Max-Age=0`);}
      if(pathname==='/contacts') {postContact(get(v,'name'),get(v,'phone'),get(v,'tag'),v.get('consent')==='yes',get(v,'note'));return redirect(res,'/contacts');}
      if(pathname==='/contacts/import') {
        const rows=parseCsv(get(v,'csv')); if(rows.length<2 || rows.length>10001) throw new Error('CSV harus memiliki header dan 1–10.000 data');
        const cols=rows.shift().map(x=>x.trim().toLowerCase()); if(!['name','phone','consent'].every(x=>cols.includes(x))) throw new Error('Header wajib: name,phone,consent');
        const prepared=rows.map((r,i)=>{if(r.length!==cols.length) throw new Error(`Jumlah kolom baris ${i+2} tidak sesuai`); const x=Object.fromEntries(cols.map((k,j)=>[k,r[j].trim()])); return {name:x.name,phone:normalizePhone(x.phone),tag:cleanTag(x.tag||''),consent:/^(yes|true|1)$/i.test(x.consent||'')};});
        db.exec('BEGIN'); try{for(const x of prepared) postContact(x.name,x.phone,x.tag,x.consent);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
        return redirect(res,'/contacts');
      }
      const opt=pathname.match(/^\/contacts\/(\d+)\/optout$/);
      if(opt) {db.prepare('UPDATE contacts SET opted_out=1-opted_out,consented=0 WHERE id=?').run(Number(opt[1]));return redirect(res,'/contacts');}
      if(pathname==='/campaigns') {
        const title=get(v,'title'), body=get(v,'body'), tag=cleanTag(get(v,'tag')), provider=get(v,'provider');
        if(!title||title.length>120||!body||body.length>3000) throw new Error('Judul dan pesan wajib diisi sesuai batas panjang');
        if(!['onesender','starsender'].includes(provider) || (provider==='starsender'&&!config.starKey)) throw new Error('Provider belum dikonfigurasi');
        const id=db.prepare('INSERT INTO campaigns(title,body,tag,provider) VALUES(?,?,?,?)').run(title,body,tag,provider).lastInsertRowid;
        return redirect(res,`/campaigns/${id}`);
      }
      const action=pathname.match(/^\/campaigns\/(\d+)\/(start|pause|resume)$/);
      if(action) {
        const id=Number(action[1]), type=action[2], campaign=db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
        if(!campaign) throw new Error('Kampanye tidak ditemukan');
        if(type==='start' && campaign.state==='draft') {
          const scheduled=get(v,'scheduled'); let iso=null;
          if(scheduled){const d=new Date(`${scheduled}:00+07:00`);if(!Number.isFinite(d.getTime())) throw new Error('Jadwal tidak valid');iso=d.toISOString();}
          db.exec('BEGIN');try{
            db.prepare(`INSERT INTO deliveries(campaign_id,contact_id,phone) SELECT ?,id,phone FROM contacts WHERE consented=1 AND opted_out=0 AND (?='' OR tag=?)`).run(id,campaign.tag,campaign.tag);
            const count=db.prepare('SELECT count(*) n FROM deliveries WHERE campaign_id=?').get(id).n;
            if(!count) throw new Error('Tidak ada kontak berizin pada segmen ini');
            db.prepare('UPDATE campaigns SET state=?,scheduled_at=? WHERE id=?').run(iso&&new Date(iso)>new Date()?'scheduled':'running',iso,id);db.exec('COMMIT');
          }catch(e){db.exec('ROLLBACK');throw e;}
        } else if(type==='pause' && ['running','scheduled'].includes(campaign.state)) db.prepare("UPDATE campaigns SET state='paused' WHERE id=?").run(id);
        else if(type==='resume' && campaign.state==='paused') {
          const provider=get(v,'provider');
          if(!['onesender','starsender'].includes(provider) || (provider==='starsender'&&!config.starKey)) throw new Error('Provider belum dikonfigurasi');
          db.prepare("UPDATE campaigns SET state='running',provider=? WHERE id=?").run(provider,id);
        }
        else throw new Error('Aksi tidak sesuai dengan status kampanye');
        return redirect(res,`/campaigns/${id}`);
      }
    }
    if(req.method==='GET' && pathname==='/') {
      const n=db.prepare('SELECT count(*) n FROM contacts').get().n;
      const c=db.prepare('SELECT count(*) n FROM campaigns').get().n;
      const a=db.prepare("SELECT count(*) n FROM deliveries WHERE state='accepted'").get().n;
      return html(res,'Ringkasan',`<h1>Ringkasan</h1><div class="row"><section><small>Kontak</small><div class="stats">${n}</div></section><section><small>Kontak berizin</small><div class="stats">${contactCount()}</div></section><section><small>Kampanye</small><div class="stats">${c}</div></section><section><small>Diterima gateway</small><div class="stats">${a}</div></section></div><section><h2>Mulai dari sini</h2><p>1. Masukkan kontak dan tandai izin yang benar-benar telah diberikan.<br>2. Buat draf kampanye.<br>3. Tinjau jumlah penerima dan mulai pengiriman.</p><p><a class="button" href="/contacts">Kelola kontak</a><a class="button" href="/campaigns">Buka kampanye</a></p></section>`,200,s);
    }
    if(req.method==='GET' && pathname==='/contacts') return renderContacts(res,s,url.searchParams.get('q'));
    if(req.method==='GET' && pathname==='/campaigns') return renderCampaigns(res,s);
    const id=pathname.match(/^\/campaigns\/(\d+)$/);
    if(req.method==='GET' && id) return renderCampaign(res,s,Number(id[1]));
    return err(res,'Halaman tidak ditemukan',s,404);
  }catch(e){console.error('Request error:',e.message);return err(res,e.message,s);}
}
if(import.meta.url===`file://${process.argv[1]}`){
  http.createServer(handler).listen(config.port,'0.0.0.0',()=>console.log(`WA CRM listening on :${config.port}`));
  setInterval(housekeeping,1000); housekeeping();
}
