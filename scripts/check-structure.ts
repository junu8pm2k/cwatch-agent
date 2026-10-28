import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

interface Manifest { name: string; dependencies?: Record<string,string>; devDependencies?: Record<string,string>; exports?: Record<string,string> }
interface Workspace { root: string; manifest: Manifest }
const root = process.cwd();
const workspaces: Workspace[] = ['apps','packages'].flatMap(parent => readdirSync(parent,{withFileTypes:true})
  .filter(entry => entry.isDirectory() && existsSync(resolve(parent,entry.name,'package.json')))
  .map(entry => ({root:resolve(parent,entry.name),manifest:JSON.parse(readFileSync(resolve(parent,entry.name,'package.json'),'utf8')) as Manifest})));
const byName = new Map(workspaces.map(workspace => [workspace.manifest.name,workspace]));
const allowed: Record<string,readonly string[]> = {
  '@cwatch/core': [],
  '@cwatch/shared': ['@cwatch/core'],
  '@cwatch/server-core': ['@cwatch/core','@cwatch/shared'],
  '@cwatch/web': ['@cwatch/core','@cwatch/shared','@cwatch/server-core'],
  '@cwatch/cli': ['@cwatch/core','@cwatch/shared','@cwatch/server-core'],
};
const errors: string[] = [];
function contained(base:string,target:string):boolean {
  const rel=relative(base,target);return rel===''||!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel);
}
function owner(file:string):Workspace|undefined{return workspaces.find(workspace=>contained(workspace.root,file));}
function walk(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(resolve(dir,entry.name)):[resolve(dir,entry.name)]);}
function fail(file:string,message:string):void{errors.push(relative(root,file).replaceAll('\\','/')+': '+message);}
function packageName(specifier:string):string{return specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];}
let files=0,imports=0;
for(const workspace of workspaces){
  if(!allowed[workspace.manifest.name])fail(workspace.root,'unclassified workspace '+workspace.manifest.name);
  for(const [subpath,target]of Object.entries(workspace.manifest.exports??{})){
    const absolute=resolve(workspace.root,target);
    if(!target.startsWith('./src/')||!contained(resolve(workspace.root,'src'),absolute)||!existsSync(absolute))fail(workspace.root,'invalid export '+subpath);
  }
  for(const file of walk(resolve(workspace.root,'src')).filter(file=>file.endsWith('.ts'))){
    files++;
    const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
    function check(specifier:string):void{
      imports++;
      if(specifier.startsWith('.')){
        const target=resolve(dirname(file),specifier);
        if(!existsSync(target))fail(file,'missing relative module '+specifier);
        if(owner(target)?.manifest.name!==workspace.manifest.name)fail(file,'cross-workspace relative import '+specifier);
        return;
      }
      if(specifier.startsWith('node:'))return;
      const name=packageName(specifier),dependency=byName.get(name);
      if(name!==workspace.manifest.name&&!Object.hasOwn(workspace.manifest.dependencies??{},name)&&!Object.hasOwn(workspace.manifest.devDependencies??{},name))fail(file,'undeclared dependency '+name);
      if(!dependency)return;
      if(name!==workspace.manifest.name&&!allowed[workspace.manifest.name]?.includes(name))fail(file,'forbidden dependency direction '+name);
      const subpath=specifier===name?'.':'.'+specifier.slice(name.length);
      if(!dependency.manifest.exports?.[subpath])fail(file,'unexported workspace module '+specifier);
    }
    function visit(node:ts.Node):void{
      if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier))check(node.moduleSpecifier.text);
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0]))check(node.arguments[0].text);
      if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteralLike(node.argument.literal))check(node.argument.literal.text);
      if(ts.isNewExpression(node)&&node.expression.getText(source)==='URL'&&node.arguments?.[1]?.getText(source)==='import.meta.url'){
        const first=node.arguments[0];if(ts.isStringLiteralLike(first)&&first.text.startsWith('.')&&!existsSync(resolve(dirname(file),first.text)))fail(file,'missing relative resource '+first.text);
      }
      ts.forEachChild(node,visit);
    }
    visit(source);
  }
}
if(errors.length){for(const error of errors)console.error(error);process.exitCode=1;}
else console.log(JSON.stringify({workspaces:workspaces.map(workspace=>workspace.manifest.name),sourceFiles:files,checkedImports:imports,gate:'PASS'}));
