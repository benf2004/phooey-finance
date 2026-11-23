import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import app from '../src/worker/index';
import type { Env } from '../src/worker/auth';

function fixture(seed = false) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync('migrations/0001_initial.sql','utf8'));
  if (seed) {
    db.prepare("INSERT INTO invoices(id,state,number,document,totals) VALUES('old','issued','OLD-0001','{}','{}')").run();
    db.prepare("INSERT INTO shares VALUES('old','old-share-hash')").run();
    db.prepare("INSERT INTO idempotency VALUES('old-key','request-hash','old',123)").run();
    db.prepare("UPDATE counters SET next_number=42").run();
  }
  db.exec(readFileSync('migrations/0002_businesses.sql','utf8'));
  function prepare(sql:string) {
    const statement = db.prepare(sql);
    const bound = (...values:any[]) => ({
      bind: (...next:any[]) => bound(...next),
      first: async () => statement.get(...values) || null,
      all: async () => ({results:statement.all(...values),meta:{changes:db.prepare('SELECT changes() AS n').get()!.n}}),
      run: async () => ({meta:{changes:Number(statement.run(...values).changes)}}),
    });
    return bound();
  }
  const env = {ADMIN_KEY:'a'.repeat(40),KEY_NAMESPACE:'test',DB:{prepare,batch:async (statements:any[])=>{db.exec('BEGIN');try {const results=[];for (const s of statements) results.push(await s.all());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}},ASSETS:{fetch:async(req:Request)=>new URL(req.url).pathname.startsWith('/fonts/') ? new Response(readFileSync('public'+new URL(req.url).pathname),{headers:{'Content-Type':'font/ttf'}}) : new Response('<html>app</html>',{headers:{'Content-Type':'text/html'}})}} as unknown as Env;
  const request = async (path:string,method='GET',data?:unknown,key=env.ADMIN_KEY!,business='default') => {
    const res = await app.fetch(new Request('https://invoice.test'+path,{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json, text/event-stream','X-Business-Id':business},body:data === undefined ? undefined : JSON.stringify(data)}),env,{waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext);
    const value = method === 'HEAD' ? null : res.headers.get('Content-Type')?.includes('json') ? await res.json() as any : await res.text();
    return {status:res.status,value,headers:res.headers};
  };
  return {db,env,request};
}
const input = {business:{name:'Studio'},billTo:{name:'Client'},items:[{description:'Design',quantity:'1',rate:'120'}]};
describe('business isolation and integration keys',()=>{
  it('migrates existing invoices, shares, retries and numbering without losing data', () => {
    const {db}=fixture(true);
    expect(db.prepare("SELECT business_id,number FROM invoices WHERE id='old'").get()).toEqual({business_id:'default',number:'OLD-0001'});
    expect(db.prepare('SELECT token_hash FROM shares').get()!.token_hash).toBe('old-share-hash');
    expect(db.prepare('SELECT business_id FROM idempotency').get()!.business_id).toBe('default');
    expect(db.prepare("SELECT next_number FROM counters WHERE id='default'").get()!.next_number).toBe(42);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('isolates invoices, customers, presets, settings and numbering, including forged ids',async()=>{
    const {request}=fixture();
    const b = (await request('/api/v1/businesses','POST',{name:'Second studio'})).value;
    const first = (await request('/api/v1/invoices','POST',{...input,status:'issued'})).value;
    const second = (await request('/api/v1/invoices','POST',{...input,status:'issued'},undefined,b.id)).value;
    expect(first.number).toBe('INV-0001');expect(second.number).toBe('INV-0001');
    expect((await request('/api/v1/invoices','GET',undefined,undefined,b.id)).value.items.map((x:any)=>x.id)).toEqual([second.id]);
    for (const method of ['GET','PUT']) expect((await request('/api/v1/invoices/'+first.id,method,method==='PUT'?{...input,revision:1}:undefined,undefined,b.id)).status).toBe(404);
    expect((await request(`/api/v1/invoices/${first.id}/share`,'POST',{revision:first.revision},undefined,b.id)).status).toBe(404);
    const customer=(await request('/api/v1/customers','POST',{party:{name:'Private client'}})).value;
    const preset=(await request('/api/v1/presets','POST',{name:'Private brand',branding:{}})).value;
    expect((await request('/api/v1/customers','GET',undefined,undefined,b.id)).value.total).toBe(0);
    expect((await request('/api/v1/presets','GET',undefined,undefined,b.id)).value.total).toBe(0);
    expect((await request('/api/v1/invoices','POST',{...input,customerId:customer.id},undefined,b.id)).status).toBe(422);
    expect((await request('/api/v1/invoices','POST',{...input,presetId:preset.id},undefined,b.id)).status).toBe(422);
    expect((await request(`/api/v1/customers/${customer.id}`,'DELETE',{revision:1},undefined,b.id)).status).toBe(404);
    expect((await request('/api/v1/settings','GET',undefined,undefined,b.id)).value.settings.business.name).toBe('Second studio');
  });
  it('hashes keys, enforces read-only and business scopes, disallows key escalation, and revokes immediately',async()=>{
    const {request,db}=fixture();
    const b=(await request('/api/v1/businesses','POST',{name:'Other business'})).value;
    const created=await request('/api/v1/keys','POST',{name:'Assistant',scope:'read'});
    expect(created.status).toBe(201);const key=created.value.key;
    expect(db.prepare('SELECT token_hash FROM api_keys').get()!.token_hash).not.toBe(key);
    expect((await request('/api/v1/invoices','GET',undefined,key)).status).toBe(200);
    expect((await request('/api/v1/invoices','POST',input,key)).status).toBe(403);
    expect((await request('/api/v1/invoices','GET',undefined,key,b.id)).status).toBe(403);
    expect((await request('/api/v1/keys','GET',undefined,key)).status).toBe(403);
    expect((await request('/api/v1/businesses','POST',{name:'No'},key)).status).toBe(403);
    expect((await request('/api/v1/keys/'+created.value.id,'DELETE')).status).toBe(200);
    expect((await request('/api/v1/invoices','GET',undefined,key)).status).toBe(401);
  });
  it('supports MCP initialize, tools/list, tools/call, and read-only protection',async()=>{
    const {request}=fixture();
    const key=(await request('/api/v1/keys','POST',{name:'MCP',scope:'read'})).value.key;
    const rpc=(method:string,params:unknown={})=>request('/mcp','POST',{jsonrpc:'2.0',id:1,method,params},key);
    const init=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
    expect(init.status).toBe(200);expect(init.value.result.serverInfo.name).toBe('phooey-invoicer');
    const list=await rpc('tools/list');
    expect(list.value.result.tools.map((t:any)=>t.name)).not.toContain('share_invoice');
    expect(list.value.result.tools.map((t:any)=>t.name)).not.toContain('revoke_invoice_share');expect(list.value.result.tools.some((t:any)=>t.name==='create_invoice')).toBe(true);
    const read=await rpc('tools/call',{name:'list_invoices',arguments:{}});expect(read.value.result.isError).toBe(false);
    const write=await rpc('tools/call',{name:'create_invoice',arguments:input});expect(write.value.result.isError).toBe(true);
    const writer=(await request('/api/v1/keys','POST',{name:'Writer',scope:'write'})).value.key;
    const draft=await request('/mcp','POST',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'create_invoice',arguments:input}},writer);
    expect(draft.value.result.isError).toBe(false);
    const saved=JSON.parse(draft.value.result.content[0].text);
    expect(saved.status).toBe('draft');expect(saved.document.billTo.name).toBe('Client');
    const pdf=await rpc('tools/call',{name:'get_invoice_pdf',arguments:{id:saved.id}});
    expect(pdf.value.result.isError).not.toBe(true);
    expect(Buffer.from(pdf.value.result.content[0].resource.blob,'base64').subarray(0,5).toString()).toBe('%PDF-');
  });
  it('preserves custom labels across save, reload and issuing',async()=>{
    const {request}=fixture();
    const created=await request('/api/v1/invoices','POST',{...input,branding:{labels:{title:'CONSULTING INVOICE',date:'Issued on',item:'Service'}}});
    expect(created.status).toBe(201);
    const fetched=await request('/api/v1/invoices/'+created.value.id);
    expect(fetched.value.document.branding.labels.date).toBe('Issued on');
    const issued=(await request(`/api/v1/invoices/${created.value.id}/issue`,'POST',{revision:created.value.revision})).value;
    expect(issued.document.branding.labels.title).toBe('CONSULTING INVOICE');
  });
  it('disables link creation and existing public links while keeping authenticated PDFs',async()=>{
    const {request,db}=fixture();
    const invoice=(await request('/api/v1/invoices','POST',{...input,status:'issued'})).value;
    const token='b'.repeat(64);
    db.prepare('INSERT INTO shares VALUES(?,?)').run(invoice.id,createHash('sha256').update(token).digest('hex'));
    for (const method of ['POST','DELETE']) {
      expect((await request(`/api/v1/invoices/${invoice.id}/share`,method,{revision:invoice.revision})).status).toBe(404);
    }
    for (const suffix of ['', '/info', '/pdf']) {
      for (const method of ['GET','HEAD']) {
        const response=await request(`/s/${token}${suffix}`,method,undefined,'');
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
    const fetched=(await request(`/api/v1/invoices/${invoice.id}`)).value;
    expect(fetched.shared).toBe(false);
    expect(fetched.revision).toBe(invoice.revision);
    expect((await request(`/api/v1/invoices/${invoice.id}/pdf`)).status).toBe(200);
    const spec=(await request('/api/v1/openapi.json')).value;
    expect(spec.paths['/invoices/{id}/share']).toBeUndefined();
  });
  it('returns a 404 for missing scripts instead of an HTML document',async()=>{
    const {request}=fixture();expect((await request('/assets/missing.js')).status).toBe(404);
  });
});
