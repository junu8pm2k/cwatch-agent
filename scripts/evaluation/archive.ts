import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { inventory } from './grader.ts';
import { sha256, within } from './dataset.ts';

const crcTable=Array.from({length:256},(_,n)=>{let crc=n;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;});
const crc32=(bytes:Buffer)=>{let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;};
/** Small, dependency-free UTF-8 ZIP; bounded archive sizes need no ZIP64. */
function zip(files:Array<{name:string;bytes:Buffer}>):Buffer {
  const locals:Buffer[]=[],central:Buffer[]=[];let offset=0,total=0;
  for(const file of files){
    if(file.name.startsWith('/')||file.name.includes('\\')||file.name.split('/').some(p=>p==='..'))throw Error('unsafe_archive_entry');
    total+=file.bytes.length;if(total>100_000_000)throw Error('archive_budget_exceeded');
    const name=Buffer.from(file.name),compressed=deflateRawSync(file.bytes),crc=crc32(file.bytes),local=Buffer.alloc(30),entry=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);
    local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(file.bytes.length,22);local.writeUInt16LE(name.length,26);
    entry.writeUInt32LE(0x02014b50,0);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(8,10);entry.writeUInt16LE(33,14);
    entry.writeUInt32LE(crc,16);entry.writeUInt32LE(compressed.length,20);entry.writeUInt32LE(file.bytes.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
    locals.push(local,name,compressed);central.push(entry,name);offset+=local.length+name.length+compressed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
export function archiveEvaluation(batchDirectory:string,secrets:string[]=[]){
  const batch=realpathSync(batchDirectory),id=randomUUID(),root=join(dirname(batch),'archives');
  mkdirSync(root,{recursive:true});if(!within(realpathSync(dirname(batch)),realpathSync(root)))throw Error('archive_directory_escape');
  const listed=inventory(batch),files=listed.map(item=>{
    const path=realpathSync(resolve(batch,item.path));if(!within(batch,path))throw Error('archive_source_escape');
    const bytes=readFileSync(path);if(sha256(bytes)!==item.sha256)throw Error('archive_source_changed');
    if(secrets.some(secret=>secret&&bytes.includes(Buffer.from(secret))))throw Error('archive_contains_credentials');
    return{name:basename(batch)+'/'+item.path,bytes};
  });
  const manifest={schemaVersion:'cwatch.eval-archive.v2',batchId:basename(batch),createdAt:new Date().toISOString(),files:listed,gitCommitRequired:false};
  const manifestName='archive-inventory-'+id+'.json',manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  writeFileSync(join(batch,manifestName),manifestBytes,{flag:'wx'});files.push({name:basename(batch)+'/'+manifestName,bytes:manifestBytes});
  const path=join(root,basename(batch)+'-'+id+'.zip');if(existsSync(path))throw Error('archive_already_exists');
  const bytes=zip(files),digest=sha256(bytes);writeFileSync(path,bytes,{flag:'wx'});writeFileSync(path+'.sha256',digest+'  '+basename(path)+'\n',{flag:'wx'});
  return{path,sha256:digest,bytes:bytes.length,fileCount:files.length,manifest:join(batch,manifestName),gitCommitRequired:false};
}
