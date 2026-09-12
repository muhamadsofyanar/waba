import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

test('CSV dan nomor: kutip, baris kosong, format nomor', async () => {
  process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'wacrm-parse-'));
  const app=await import('../src/app.mjs?parse');
  assert.deepEqual(app.parseCsv('name,phone\n"Budi, S",0812\n'),[['name','phone'],['Budi, S','0812']]);
  assert.equal(app.normalizePhone('0812 3456 7890'),'6281234567890');
  assert.throws(()=>app.normalizePhone('abc'));
  rmSync(process.env.DATA_DIR,{recursive:true,force:true});
});

for (const provider of ['onesender','starsender']) test(`kontak → kampanye → ${provider} diterima gateway`, async () => {
  const dir=mkdtempSync(path.join(tmpdir(),`wacrm-${provider}-`));
  Object.assign(process.env,{DATA_DIR:dir,ADMIN_EMAIL:'admin@test.local',ADMIN_PASSWORD:'a strong test password',SESSION_SECRET:'0123456789abcdef0123456789abcdef',ONESENDER_API_URL:'https://onesender.example.test/api/v1/messages',ONESENDER_API_KEY:'test-only',STARSENDER_DEVICE_API_KEY:'star-test-only'});
  const app=await import(`../src/app.mjs?${provider}`);
  const server=http.createServer(app.handler);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const base=`http://127.0.0.1:${server.address().port}`;
  const realFetch=globalThis.fetch; let outbound;
  try {
    const login=await realFetch(base+'/login',{method:'POST',body:new URLSearchParams({email:'admin@test.local',password:'a strong test password'}),redirect:'manual'});
    assert.equal(login.status,303); const cookie=login.headers.get('set-cookie').split(';')[0];
    const page=await realFetch(base+'/contacts',{headers:{cookie}}); const token=(await page.text()).match(/name="csrf" value="([0-9a-f]+)"/)[1];
    const home=await realFetch(base+'/',{headers:{cookie}});
    assert.match(await home.text(),/Kontak berizin/);
    const post=async(url,data)=>realFetch(base+url,{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:token,...data}),redirect:'manual'});
    const imported=await post('/contacts/import',{csv:'name,phone,tag,consent\nAlice,081234567890,buyer,yes\nBob,081299999999,buyer,no'});
    assert.equal(imported.status,303);
    const campaign=await post('/campaigns',{title:'Test',body:'Halo {{name}}',tag:'buyer',provider});
    assert.equal(campaign.status,303);const target=campaign.headers.get('location');
    const draft=await realFetch(base+target,{headers:{cookie}});
    assert.match(await draft.text(),/Penerima saat ini: 1/);
    const started=await post(target+'/start',{});assert.equal(started.status,303);
    const db=new DatabaseSync(path.join(dir,'crm.db'));
    assert.equal(db.prepare('SELECT count(*) n FROM deliveries').get().n,1);
    globalThis.fetch=async(url,opts)=>{outbound={url,opts};return new Response(JSON.stringify(provider==='onesender'?{code:200}:{success:true}),{status:200});};
    await app.sendOne();
    assert.equal(db.prepare('SELECT state FROM deliveries').get().state,'accepted');
    assert.equal(db.prepare('SELECT state FROM campaigns').get().state,'done');
    const payload=JSON.parse(outbound.opts.body);
    assert.equal(payload.to,'6281234567890');
    if(provider==='starsender'){assert.equal(outbound.url,'https://api.starsender.online/api/send');assert.equal(outbound.opts.headers.Authorization,'star-test-only');assert.equal(payload.body,'Halo Alice');}
    else {assert.equal(outbound.url,'https://onesender.example.test/api/v1/messages');assert.equal(outbound.opts.headers.Authorization,'Bearer test-only');assert.equal(payload.text.body,'Halo Alice');}
    db.close();
  } finally {globalThis.fetch=realFetch;server.close();rmSync(dir,{recursive:true,force:true});}
});
