import {resolve} from 'node:path';
/** Match native absolute, repo-relative and slashless absolute descriptors to the same explicit whitelist. */
export function pilotPermission(directory,allowedWrites,validation,description){
 try{
  const i=description.indexOf('\n');if(i<0)return false;
  const header=description.slice(0,i),metadata=JSON.parse(description.slice(i+1));
  const allowed=new Set(allowedWrites.map(p=>resolve(directory,p)));
  const permitted=p=>typeof p==='string'&&p.length>0&&[resolve(directory,p),resolve('/',p)].some(p=>allowed.has(p));
  if(header.startsWith('edit: ')){
   const paths=header.slice(6).split(', ');if(!paths.length||!paths.every(permitted))return false;
   return metadata.filepath===undefined||permitted(metadata.filepath);
  }
  if(header.startsWith('bash: '))return validation.includes(metadata.command)&&(!metadata.workdir||resolve(metadata.workdir)===resolve(directory));
  return false;
 }catch{return false;}
}
