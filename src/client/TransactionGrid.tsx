import { useSubmit, api } from "./api";
import { useWorkspace } from "./context";
import { GridColumn, LedgerGrid } from "./LedgerGrid";
import type { Transaction, TransactionFieldEdit, TransactionInput } from "../shared/models";
import { amountInput, formatMoney, parseMoney } from "../shared/money";

export function TransactionGrid({rows,tagsOnly,onSaved}: {rows:Transaction[];tagsOnly:boolean;onSaved:(row:Transaction,edit:TransactionFieldEdit,revision:number)=>void}) {
  const {categories,refresh} = useWorkspace();
  const submit = useSubmit();
  async function patch(row:Transaction, edit:TransactionFieldEdit) {
    try {
      const result = await submit<{revision:number}>("/transactions/"+row.id,{edit,revision:row.revision},"PATCH");
      onSaved(row,edit,result.revision);
    } catch(e) { refresh();throw e; }
  }
  async function editDetails(row:Transaction, changes:Partial<TransactionInput>) {
    const url="/transactions/"+row.id;
    try {
      const full=await api<Transaction & {splits:TransactionInput["splits"]}>(url);
      if(full.revision!==row.revision) throw Error("This transaction changed. Press Esc and reopen the cell to see the latest value.");
      await submit(url,{transaction:{...full,reviewed:!!full.reviewed,pending:!!full.pending,...changes},revision:row.revision},"PUT");
    } finally {refresh();}
  }
  const cols:GridColumn<Transaction>[] = [
    {key:"posted",title:"Date",type:"date",value:r=>r.posted,save:(r,v)=>editDetails(r,{posted:v}),locked:r=>!!r.transfer_id},
    {key:"description",title:"Description",value:r=>r.description,save:(r,v)=>patch(r,{field:"description",value:v})},
    {key:"tags",title:"Tags",value:r=>JSON.stringify(r.tags),display:r=>r.tags.length ? <span className="grid-chips">{r.tags.map(t=><span key={t}>{t}</span>)}</span> : "Add tags",type:"tags",save:(r,v)=>patch(r,{field:"tags",value:JSON.parse(v)})},
    {key:"account",title:"Account",value:r=>r.account_name},
    {key:"amount",title:"Amount",type:"number",value:r=>amountInput(r.amount),display:r=>formatMoney(r.amount,r.currency),locked:r=>!!r.transfer_id || !!r.split_count,save:(r,v)=>editDetails(r,{amount:parseMoney(v)})},
    {key:"category",title:"Category",value:r=>r.category_id??"",display:r=>r.split_count?"Split":r.category_name??"Uncategorized",options:[{value:"",label:"Uncategorized"},...categories.map(c=>({value:c.id,label:c.name}))],locked:r=>!!r.split_count || !!r.transfer_id,save:(r,v)=>patch(r,{field:"category_id",value:v||null})},
    {key:"merchant",title:"Merchant",value:r=>r.merchant,save:(r,v)=>patch(r,{field:"merchant",value:v})},
    {key:"notes",title:"Notes",value:r=>r.notes,save:(r,v)=>patch(r,{field:"notes",value:v})},
    {key:"reviewed",title:"Review",value:r=>String(r.reviewed),options:[{value:"1",label:"Reviewed"},{value:"0",label:"Needs review"}],save:(r,v)=>patch(r,{field:"reviewed",value:v==="1"})},
  ];
  return <LedgerGrid rows={rows} columns={tagsOnly ? cols.filter(c=>["description","tags","account","posted"].includes(c.key)) : cols} label={(tagsOnly?"Tag assignments":"Transactions")+" spreadsheet"}/>;
}
