import { assert, randomToken, hash } from '../server/util';
import { challenge, consume, cookie, customer, hasAccess, issueSession, portal, readCookie, redirect, workspace, type HostedEnv, type Slot } from './control';

export const invoiceOrigin = (env: HostedEnv) => env.INVOICER_ORIGIN || '';
const invoiceService = (env: HostedEnv, id: string) => env[`WORKSPACE_SERVICE_${id.replaceAll('-','_')}`];
// Only this host owns Invoicer cookies. One-use handoffs are bound to the browser
// that started sign-in; Finance's cookie is never shared across subdomains.
export async function invoiceDomain(req: Request, env: HostedEnv): Promise<Response> {
  const url = new URL(req.url), p = url.pathname, origin = invoiceOrigin(env);
  const read = ['GET','HEAD'].includes(req.method);
  if (p === '/auth/accept' && read) {
    const grant = await consume(env, 'invoice-login', url.searchParams.get('ticket') || '');
    assert(grant.nonce === readCookie(req,'invoice_enter'),403,'Start sign-in again from Invoicer.');
    const res = redirect('/', await issueSession(env,grant.customer,origin));
    res.headers.append('Set-Cookie',cookie('invoice_enter','',0));
    return res;
  }
  if (p.startsWith('/invoicer') && read) return redirect(origin+(p.slice('/invoicer'.length)||'/')+url.search);
  const publicMatch = p.match(/^\/w\/([a-z][a-z0-9-]{0,23})(\/s\/[a-zA-Z0-9_-]+(?:\/(?:pdf|info))?)$/);
  if (publicMatch && read) {
    const slot = await env.CONTROL.prepare('SELECT * FROM workspaces WHERE id=?').bind(publicMatch[1]).first<Slot>();
    const service = slot && invoiceService(env,slot.id);
    assert(slot && service,404,'Invoice unavailable.');
    // The workspace validates subscription and share token independently.
    return service.fetch(new Request(slot.origin+'/invoicer'+publicMatch[2],{method:req.method,headers:{Accept:req.headers.get('Accept') || '*/*'}}));
  }
  if (read && /^\/(?:assets\/|fonts\/|phooey-wordmark\.svg$|favicon\.svg$|LICENSE\.txt$)/.test(p)) {
    assert(env.INVOICER_ASSETS,404,'Asset unavailable.');
    return env.INVOICER_ASSETS.fetch(new Request(url,{method:req.method}));
  }
  // The namespace selects a workspace, never authorizes it. The invoice Worker
  // hashes and verifies the complete key before granting any business access.
  const bearer = req.headers.get('Authorization');
  const keySlot = bearer?.match(/^Bearer phinv_([a-z][a-z0-9-]{0,23})_[0-9a-f]{64}$/)?.[1];
  if (bearer && (p.startsWith('/api/') || p === '/mcp')) {
    assert(keySlot,401,'Invalid Invoicer API key.');
    const service = invoiceService(env,keySlot);
    assert(service,401,'Invalid Invoicer API key.');
    const target = new URL('/invoicer'+p+url.search,origin);
    return service.fetch(new Request(target,req));
  }
  const account = await customer(env,req);
  if (!account) {
    if (p.startsWith('/api/') || p === '/mcp' || p === '/auth/session') return Response.json({error:{message:'Please sign in'}},{status:401});
    const nonce = randomToken();
    return redirect(portal(env)+'/cloud/invoicer?nonce='+nonce,cookie('invoice_enter',nonce,300));
  }
  assert(hasAccess(account),402,'Open your Phooey account to renew your subscription.');
  if (p === '/auth/logout' && req.method === 'POST') {
    assert(req.headers.get('Origin') === origin,403,'Use the Invoicer app.');
    await env.CONTROL.prepare('DELETE FROM sessions WHERE digest=? AND audience=?').bind(await hash(readCookie(req,'session')),origin).run();
    const res = Response.json({ok:true}); res.headers.set('Set-Cookie',cookie('session','',0)); return res;
  }
  const slot = await workspace(env,account.id), service = slot && invoiceService(env,slot.id);
  assert(service,503,'Your Invoicer workspace is temporarily unavailable.');
  return service.fetch(new Request(new URL('/invoicer'+p+url.search,origin),req));
}
export async function invoiceHandoff(req: Request, env: HostedEnv) {
  const nonce = new URL(req.url).searchParams.get('nonce') || readCookie(req,'invoice_nonce');
  assert(/^[A-Za-z0-9_-]{43}$/.test(nonce),400,'Open Invoicer to start sign-in.');
  const account = await customer(env,req);
  if (!account) return redirect('/cloud/start?next=/cloud/invoicer',cookie('invoice_nonce',nonce,300));
  assert(hasAccess(account),402,'Open your Phooey account to renew your subscription.');
  const ticket = await challenge(env,'invoice-login',{customer:account.id,nonce},90);
  return redirect(invoiceOrigin(env)+'/auth/accept?ticket='+ticket,cookie('invoice_nonce','',0));
}
