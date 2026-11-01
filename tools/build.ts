#!/usr/bin/env bun
/** Assemble a candidate package from an explicit atlas. Never install or publish. */
import {createHash} from 'node:crypto';
import {copyFile,lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import sharp from 'sharp';
import {contract,decode,preview,validateAtlas} from './pet';
import {packageRuntime,runtimePetId,type RuntimePetId} from './package';
import {previewInstaller} from './stage-review-package';
import {updateChecksums} from './update-checksums';

const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
async function ordinary(path:string){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink())throw Error('Input must be an ordinary file');return readFile(path);}
export async function buildRuntime(options:{atlas:string;sha256:string;out:string;id:RuntimePetId;root?:string}){
 const root=resolve(options.root??join(import.meta.dir,'..')),atlas=resolve(root,options.atlas),out=resolve(root,options.out),id=runtimePetId(options.id);
 if(!/^[a-f0-9]{64}$/.test(options.sha256))throw Error('Expected atlas SHA256 is required');
 const rel=relative(join(root,'dist'),out);
 if(!rel||rel==='..'||rel.startsWith('..'+sep)||resolve(out)===resolve(atlas)||rel.startsWith(sep))throw Error('Output must be a new folder below dist');
 let current=root;
 for(const part of relative(root,out).split(sep)){current=join(current,part);const s=await lstat(current).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});if(s?.isSymbolicLink()||(s&&!s.isDirectory()))throw Error('Output cannot follow a link or file');if(s&&current===out)throw Error('Output already exists');}
 const bytes=await ordinary(atlas);
 if(sha(bytes)!==options.sha256)throw Error('Atlas SHA256 mismatch');
 const metadata=await sharp(bytes).metadata();
 if(metadata.format!=='webp'||(metadata.pages??1)!==1)throw Error('Atlas must be a static WebP');
 if(metadata.exif||metadata.xmp||metadata.iptc||metadata.icc)throw Error('Atlas contains embedded metadata; review before export');
 const c=await contract(),decoded=await decode(atlas,c),validation=validateAtlas(decoded,c);
 if(!validation.valid)throw Error('Invalid atlas: '+validation.problems.join('; '));
 const licenses: {name:string;bytes:Buffer}[]=[];
 for(const name of ['LICENSE','LICENSE-ARTWORK']){const p=join(root,name),stat=await lstat(p).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});if(stat){const bytes=await ordinary(p);if(!bytes.toString().trim())throw Error('Empty license: '+name);licenses.push({name,bytes});}}
 if(licenses.length!==0&&licenses.length!==2)throw Error('Both LICENSE and LICENSE-ARTWORK are required together');
 const scripts=await Promise.all(['install.sh','uninstall.sh'].map(async name=>({name,body:(await ordinary(join(root,name))).toString()})));
 await mkdir(dirname(out),{recursive:true});await mkdir(out);const runtime=join(out,'runtime');await mkdir(runtime);
 const name=id==='louis'?'Louis':'Louis Motion Preview',story='Louis rules the day with tiny acts of mischief and very important naps.';
 await writeFile(join(runtime,'spritesheet.webp'),bytes,{flag:'wx'});
 await writeFile(join(runtime,'pet.json'),JSON.stringify({id,displayName:name,description:story,spriteVersionNumber:2,spritesheetPath:'spritesheet.webp'},null,2)+'\n',{flag:'wx'});
 for(const script of scripts)await writeFile(join(runtime,script.name),id==='louis'?script.body:previewInstaller(script.body),{flag:'wx'});
 await copyFile(join(root,'.gitignore'),join(runtime,'.gitignore'));
 for(const license of licenses)await writeFile(join(runtime,license.name),license.bytes,{flag:'wx'});
 await writeFile(join(runtime,'README.md'),"# {{name}}\n\n{{story}}\n\n![Louis animation preview](preview.gif)\n\n## Install\n\nGive your Codex agent this prompt:\n\n```text\nInstall pet from https://github.com/dhruvaldarji/ai-pet-shihtzu\n```\n\nThe agent uses supported pet tools when available. Use the following steps only if it cannot complete installation.\n\nFor a local pet, extract this ZIP and run `sh install.sh` in its folder. The default target is `~/.codex/pets/{{id}}`. The installer keeps a backup before replacing existing local files.\n\nSet `LOUIS_CODEX_DIR` for another local root. Run `sh uninstall.sh` to remove the local pet and keep a backup.\n\nLocal installation does not update a ChatGPT Work cloud pet. For a new cloud pet, open Settings, then Pets, then Upload pet. Enter a name and choose this package's `spritesheet.webp`. Select the uploaded pet if needed; do not upload it again to fix selection.\n\nUpload creates a new pet. An existing cloud pet needs its supported update tool when available. Check the selected pet on screen after either method.\n\n## Files and behavior\n\n`pet.json` and `spritesheet.webp` are the local pet files. The app controls animation timing and may skip the first-use wave.\n\nThe preview GIF uses fewer colors. Use the sprite sheet to check the exact artwork.\n\nSoftware terms are in [LICENSE](LICENSE). Artwork terms are in [LICENSE-ARTWORK](LICENSE-ARTWORK). Dependency licenses remain separate.\n".replaceAll("{{name}}",name).replaceAll("{{story}}",story).replaceAll("{{id}}",id).replaceAll("{{atlasSha256}}",options.sha256).replace("Software terms are in [LICENSE](LICENSE). Artwork terms are in [LICENSE-ARTWORK](LICENSE-ARTWORK). Dependency licenses remain separate.",licenses.length?"Software terms are in [LICENSE](LICENSE). Artwork terms are in [LICENSE-ARTWORK](LICENSE-ARTWORK). Dependency licenses remain separate.":"No license terms were supplied with this build."),{flag:'wx'});
 await writeFile(join(runtime,'RELEASE_NOTES.md'),"# {{name}}\n\nLouis naps, travels, reacts while you work, and follows your cursor.\n\n## Package details\n\n- Pet ID: `{{id}}`\n- Sprite format: 2\n- Sprite sheet SHA256: `{{atlasSha256}}`\n\nThe package keeps the source sprite sheet unchanged. The app controls animation timing. Its first-use wave may not appear or replay when you select Louis again.\n\nThe local installer saves a backup before replacing existing files. Cloud pets use the app's supported tools or upload flow. A local installation does not update a cloud pet.\n\nSoftware terms are in [LICENSE](LICENSE). Artwork terms are in [LICENSE-ARTWORK](LICENSE-ARTWORK). Dependency licenses remain separate.\n".replaceAll("{{name}}",name).replaceAll("{{story}}",story).replaceAll("{{id}}",id).replaceAll("{{atlasSha256}}",options.sha256).replace("Software terms are in [LICENSE](LICENSE). Artwork terms are in [LICENSE-ARTWORK](LICENSE-ARTWORK). Dependency licenses remain separate.",licenses.length?"Software terms are in [LICENSE](LICENSE). Artwork terms are in [LICENSE-ARTWORK](LICENSE-ARTWORK). Dependency licenses remain separate.":"No license terms were supplied with this build."),{flag:'wx'});
 await preview(join(runtime,'spritesheet.webp'),'idle',join(runtime,'preview.gif'),192);await updateChecksums(runtime);
 const packaged=await packageRuntime(join(out,id+'.zip'),runtime,{petId:id});
 const receipt={version:1,status:'candidate-package-awaiting-review',atlasSha256:options.sha256,atlasRgbaSha256:sha(decoded.pixels),petId:id,payload:packaged.manifest,archiveSha256:packaged.archiveSha256,installed:false,published:false,artworkAccepted:false,licensePresent:licenses.length===2,licenseFiles:licenses.map(x=>x.name)};
 await writeFile(join(out,'build.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
if(import.meta.main){try{const args=process.argv.slice(2);if(args[0]==='--')args.shift();const p:Record<string,string>={};for(let i=0;i<args.length;i+=2){if(!['--atlas','--sha256','--out','--id'].includes(args[i])||!args[i+1]||p[args[i]])throw Error('Usage: build --atlas file --sha256 hash --out dist/new-folder --id louis|louis-motion-preview');p[args[i]]=args[i+1];}if(Object.keys(p).length!==4)throw Error('All four build inputs are required');console.log(JSON.stringify(await buildRuntime({atlas:p['--atlas'],sha256:p['--sha256'],out:p['--out'],id:runtimePetId(p['--id'])}),null,2));}catch(e){console.error(JSON.stringify({error:(e as Error).message}));process.exitCode=1;}}
