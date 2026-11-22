import { Buffer } from 'node:buffer';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { invoiceInputSchema, partySchema } from '../shared/model';
import type { Env } from './auth';

// Tools use the REST handlers so validation, revision checks and business isolation
// are identical whether an invoice is edited in the dashboard or by an assistant.
export async function handleMcp(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void }, scope: string, dispatch: (request: Request) => Promise<Response>) {
  const factory = () => {
    const server = new McpServer({name:'phooey-invoicer',version:'1.0.0'});
    function tool<S extends z.ZodRawShape>(name:string,description:string,schema:z.ZodObject<S>,readOnly:boolean,route:(a:any)=>{path:string;method?:string;data?:unknown}) {
      server.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,openWorldHint:false}},async args => {
        if (!readOnly && scope === 'read') return {isError:true,content:[{type:'text' as const,text:'This API key is read-only.'}]};
        const target = route(args);
        const headers = new Headers(request.headers);
        headers.set('Content-Type','application/json'); headers.set('Accept','application/json');
        headers.delete('Content-Length');
        const response = await dispatch(new Request(new URL('/api/v1'+target.path,request.url),{method:target.method || 'GET',headers,body:target.data === undefined ? undefined : JSON.stringify(target.data)}));
        return {isError:!response.ok,content:[{type:'text' as const,text:await response.text()}]};
      });
    }
    const id = z.string().uuid();
    const revision = z.number().int().positive();
    tool('list_businesses','Read the business accessible to this key.',z.object({}),true,()=>({path:'/businesses'}));
    tool('get_settings','Read business details and invoice defaults.',z.object({}),true,()=>({path:'/settings'}));
    tool('list_invoices','Search invoices. Amounts in results are currency minor units.',z.object({q:z.string().max(100).optional(),status:z.enum(['all','draft','issued','paid','void','overdue']).optional(),page:z.number().int().positive().default(1),limit:z.number().int().min(1).max(100).default(25)}),true,a=>({path:'/invoices?'+new URLSearchParams(Object.entries(a).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]))}));
    tool('get_invoice','Read an invoice and its current revision.',z.object({id}),true,a=>({path:`/invoices/${a.id}`}));
    server.registerTool('get_invoice_pdf', {
      description:'Download the PDF of a saved invoice as a PDF resource.',
      inputSchema:z.object({id}), annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    }, async ({id}) => {
      const headers = new Headers(request.headers); headers.set('Accept','application/pdf'); headers.delete('Content-Length');
      const response = await dispatch(new Request(new URL(`/api/v1/invoices/${id}/pdf`,request.url),{headers}));
      if (!response.ok) return {isError:true,content:[{type:'text' as const,text:await response.text()}]};
      return {content:[{type:'resource' as const,resource:{uri:`invoicer://invoices/${id}/invoice.pdf`,mimeType:'application/pdf',blob:Buffer.from(await response.arrayBuffer()).toString('base64')}}]};
    });
    tool('create_invoice','Create an invoice draft. Does not issue or share it.',invoiceInputSchema.omit({status:true}),false,a=>({path:'/invoices',method:'POST',data:{...a,status:'draft'}}));
    tool('update_invoice','Replace an active draft with the supplied document. Read it first and include its current revision.',invoiceInputSchema.omit({status:true}).extend({id,revision}),false,a=>({path:`/invoices/${a.id}`,method:'PUT',data:a}));
    tool('list_customers','List saved customers for this business.',z.object({page:z.number().int().positive().default(1)}),true,a=>({path:`/customers?page=${a.page}`}));
    tool('create_customer','Save a customer for reuse on invoices.',z.object({party:partySchema}),false,a=>({path:'/customers',method:'POST',data:a}));
    tool('update_customer','Update a customer using its current revision.',z.object({id,revision,party:partySchema}),false,a=>({path:`/customers/${a.id}`,method:'PUT',data:a}));
    tool('list_presets','Read saved invoice branding presets.',z.object({}),true,()=>({path:'/presets'}));
    tool('record_payment','Set the cumulative amount already paid, as a decimal string in the invoice currency. This records payment; it does not transfer money.',z.object({id,revision,amountPaid:z.string()}),false,a=>({path:`/invoices/${a.id}/payment`,method:'POST',data:a}));
    for (const action of ['issue','duplicate','archive','restore','void','share'] as const) {
      tool(action+'_invoice',action === 'share' ? 'Create a public read link. Anyone with the link can read the invoice. Requires explicit user intent to share.' : `${action} an invoice using its current revision. Issue freezes its contents.`,z.object({id,revision}),false,a=>({path:`/invoices/${a.id}/${action}`,method:'POST',data:{revision:a.revision}}));
    }
    tool('revoke_invoice_share','Revoke public access to an invoice.',z.object({id,revision}),false,a=>({path:`/invoices/${a.id}/share`,method:'DELETE',data:{revision:a.revision}}));
    return server;
  };
  const url = new URL(request.url);
  if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) return new Response('Invalid origin',{status:403});
  if (request.method !== 'POST') return new Response('Method not allowed',{status:405,headers:{Allow:'POST'}});
  const server = factory();
  const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await server.connect(transport);
  try { const response = await transport.handleRequest(request); return new Response(await response.arrayBuffer(),response); }
  finally { await server.close(); }
}
