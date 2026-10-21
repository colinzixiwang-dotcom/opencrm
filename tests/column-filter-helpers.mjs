import assert from 'node:assert/strict';
export async function selectColumnFilter(page,label,value) {
 await page.getByLabel(label,{exact:true}).click();
 const options=page.getByRole('listbox').getByRole('option');
 const index=await options.evaluateAll((items,value)=>items.findIndex(item=>item.dataset.value===value),value);
 assert(index>=0,`Missing ${label} option ${value}`);
 await options.nth(index).click();
}
