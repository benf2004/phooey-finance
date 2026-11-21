import type { Account, Category, Rule } from "../shared/models";
import { amountInput, formatMoney, parseMoney } from "../shared/money";
import { useWorkspace } from "./context";
import { formatEnumLabel } from "./labels";
import { GridColumn, LedgerGrid } from "./LedgerGrid";
import { useSubmit } from "./api";

export function options(values: string[]) {
  return values.map(value => ({value, label:formatEnumLabel(value)}));
}
export function CatalogGrid({table, rules = []}: {table:"accounts"|"categories"|"rules"; rules?: Rule[]}) {
  const {accounts, categories, refresh} = useWorkspace();
  const submit = useSubmit();
  function field<R, K extends keyof R>(key: K, title: string, extra: Partial<GridColumn<R>> = {}, parse: (s:string)=>string|number|boolean = s=>s): GridColumn<R> {
    return {
      key:String(key), title, value:r=>String(r[key] ?? ""),
      save: async(row, draft) => {
        try {await submit("/"+table+"/"+(row as R & {id:string}).id, {field:key,previous:row[key],value:parse(draft)}, "PATCH");}
        finally { refresh(); }
      }, ...extra,
    };
  }
  if (table === "accounts") {
    const cols:GridColumn<Account>[] = [
      field("name","Account"), field("institution","Institution"), field("kind","Type",{options:options(["checking","savings","credit","cash","investment","loan","other"])}),
      {key:"currency",title:"Currency",value:r=>r.currency},
      field("balance","Balance",{type:"number",value:r=>amountInput(r.balance),display:r=>formatMoney(r.balance,r.currency),locked:r=>r.source!=="manual"},parseMoney),
      {key:"source",title:"Source",value:r=>r.source==="manual"?"Manual":"SimpleFIN"},
    ];
    return <LedgerGrid rows={accounts} columns={cols} label="Accounts spreadsheet"/>;
  }
  if (table === "categories") {
    const cols:GridColumn<Category>[] = [
      field("name","Category"),field("type","Type",{options:options(["expense","income","transfer"])}),
      field("tax_treatment","Tax treatment",{options:options(["personal","business_income","business_expense","tax_payment","excluded"])}),
      field("color","Color",{display:r=><><i className="grid-swatch" style={{background:r.color}}/>{r.color}</>}),
    ];
    return <LedgerGrid rows={categories} columns={cols} label="Categories spreadsheet"/>;
  }
  const cols:GridColumn<Rule>[] = [
    field("name","Rule"),field("pattern","Match text"),field("category_id","Category",{options:categories.map(c=>({value:c.id,label:c.name}))}),
    field("priority","Priority",{type:"number"},s=>/^\d+$/.test(s.trim())?Number(s):NaN),
    field("enabled","Status",{options:[{value:"1",label:"Enabled"},{value:"0",label:"Paused"}]},s=>s==="1"),
  ];
  return <LedgerGrid rows={rules} columns={cols} label="Rules spreadsheet"/>;
}
