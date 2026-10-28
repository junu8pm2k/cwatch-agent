export const OUTPUT_CONTRACTS=['json_object_only','single_json_block','json_artifact_with_prose'] as const;
export type OutputContract=typeof OUTPUT_CONTRACTS[number];

export function outputContractInstruction(contract:OutputContract):string{
  switch(contract){
    case 'json_object_only':return '最终答复只能包含一个 JSON 对象，允许外层空白；禁止 Markdown 代码围栏、解释、标题以及任何前后缀文字。';
    case 'single_json_block':return '最终答复只能包含一个 JSON 对象，可直接返回或放在唯一的 json 代码围栏中；不得附带其他文字。';
    case 'json_artifact_with_prose':return '最终答复须包含唯一 JSON 对象：可直接返回 JSON，或放在唯一的 json 代码围栏中并附带说明；禁止多个候选 JSON 块。';
  }
}
export function parseFinalJson(text:string){
  const trimmed=text.trim(),sole=trimmed.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1');
  const object=(value:unknown)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  try{const value:unknown=JSON.parse(sole);return{value,formatValid:object(value),extraction:sole===trimmed?'entire':'sole_fence'};}
  catch{
    const blocks=[...trimmed.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
    if(blocks.length===1)try{const value:unknown=JSON.parse(blocks[0][1]);if(object(value))return{value,formatValid:false,extraction:'embedded_fence'};}catch{/* No guessed or repaired JSON. */}
    return{value:null,formatValid:false,extraction:'none'};
  }
}
export function inspectFinalOutput(text:string,contract?:OutputContract){
  const parsed=parseFinalJson(text);
  let valid:boolean|null=null;
  if(contract==='json_object_only')valid=parsed.formatValid&&parsed.extraction==='entire';
  if(contract==='single_json_block')valid=parsed.formatValid;
  if(contract==='json_artifact_with_prose')valid=parsed.value!==null&&typeof parsed.value==='object'&&!Array.isArray(parsed.value);
  return{value:parsed.value,formatValid:valid,extraction:parsed.extraction,contract:contract??null};
}
