import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseSkill, type SkillBundle } from '@cwatch/shared/skills/storage';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const path=z.string().min(1).max(240).refine(value=>!value.includes('\\')&&!value.includes(':')&&!value.startsWith('/')&&value.split('/').every(p=>p&&p!=='.'&&p!=='..'),'Unsafe skill resource path');
const sha256=(text:string)=>createHash('sha256').update(text).digest('hex');
export const FrozenSkillSchema=z.object({name:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),entry:z.string().min(1).max(65536),sha256:digest,
  resources:z.array(z.object({path,text:z.string().max(24000),sha256:digest}).strict()).max(32),
}).strict().superRefine((v,ctx)=>{
  try{if(parseSkill(v.entry).name!==v.name)ctx.addIssue({code:'custom',message:'Skill snapshot name mismatch'});}catch{ctx.addIssue({code:'custom',message:'Invalid frozen Skill entry'});}
  if(sha256(v.entry)!==v.sha256||v.resources.some(r=>sha256(r.text)!==r.sha256))ctx.addIssue({code:'custom',message:'Skill snapshot digest mismatch'});
  if(new Set(v.resources.map(r=>r.path)).size!==v.resources.length)ctx.addIssue({code:'custom',message:'Duplicate frozen Skill resource'});
});
export type FrozenSkill=z.infer<typeof FrozenSkillSchema>;
/** Same host SkillBundle interface as installed Skills, backed only by frozen case input. */
export function frozenSkillBundle(raw:FrozenSkill[]):SkillBundle|undefined {
  if(!raw.length)return undefined;
  const skills=raw.map(s=>FrozenSkillSchema.parse(s)),byName=new Map(skills.map(s=>[s.name,s]));
  if(byName.size!==skills.length)throw Error('duplicate_frozen_skill');
  return {documents:skills.map(s=>{const parsed=parseSkill(s.entry);return{name:s.name,description:parsed.description,body:parsed.body,hash:s.sha256,resources:s.resources.map(r=>r.path)};}),
    readResource:(name,path,offset,limit)=>{
      const skill=byName.get(name);if(!skill)throw Error('skill_not_selected');
      const resource=skill.resources.find(r=>r.path===path);if(!resource)throw Error('skill_resource_not_installed');
      if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>24000)throw Error('skill_resource_range_invalid');
      return{text:resource.text.slice(offset,offset+limit),hash:resource.sha256,totalChars:resource.text.length,truncated:offset+limit<resource.text.length};
    }};
}
