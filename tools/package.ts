#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { contract, decode, validateAtlas } from "./pet";

export const RUNTIME_FILES = [".gitignore","README.md","RELEASE_NOTES.md","pet.json","spritesheet.webp","preview.gif","install.sh","uninstall.sh","SHA256SUMS"] as const;
export const OPTIONAL_RUNTIME_FILES = ["LICENSE","LICENSE-ARTWORK"] as const;
const TEXT_FILES=new Set([".gitignore","README.md","RELEASE_NOTES.md","pet.json","install.sh","uninstall.sh","SHA256SUMS",...OPTIONAL_RUNTIME_FILES]);
const sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
export type RuntimePetId="louis"|"louis-motion-preview";
export function runtimePetId(value:string):RuntimePetId {
  if(value!=="louis"&&value!=="louis-motion-preview")throw new Error("Pet ID must be louis or louis-motion-preview");
  return value;
}

/** Exact runtime allowlist. Optional entries must be ordinary files, even if their link target is missing. */
export async function runtimeFileNames(root:string):Promise<string[]> {
  const names:string[]=RUNTIME_FILES.filter(name=>name!=="SHA256SUMS");
  for(const name of OPTIONAL_RUNTIME_FILES) {
    const stat=await lstat(join(root,name)).catch((error:NodeJS.ErrnoException)=>{
      if(error.code==="ENOENT") return null;
      throw error;
    });
    if(stat) {
      if(!stat.isFile()||stat.isSymbolicLink()) throw new Error(`Unsafe optional runtime file: ${name}`);
      names.push(name);
    }
  }
  if(names.includes("LICENSE")!==names.includes("LICENSE-ARTWORK")) throw new Error("Runtime licenses must include both LICENSE and LICENSE-ARTWORK");
  return [...names,"SHA256SUMS"];
}

async function run(argv:string[],cwd?:string):Promise<string> {
  let proc;
  try {proc=Bun.spawn(argv,{cwd,env:{...process.env,TZ:"UTC"},stdout:"pipe",stderr:"pipe"});}
  catch {throw new Error(`Required archive command is unavailable: ${argv[0]}`);}
  const [output,error,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  if(code!==0) throw new Error(`${argv[0]} failed: ${error.trim()||output.trim()}`);
  return output;
}

function checkText(name:string,body:string) {
  const homePath=/(?:\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\)/;
  const secret=/(?:-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|(?:api[_-]?key|auth[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s"'`]+|gh[pousr]_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16})/i;
  if(homePath.test(body)) throw new Error(`${name} contains an absolute user-home path`);
  if(secret.test(body)) throw new Error(`${name} contains a secret marker`);
}

function parseChecksums(body:string,dataFiles:string[]) {
  const lines=body.trimEnd().split(/\r?\n/);
  const map=new Map<string,string>();
  for(const line of lines) {
    const match=/^([a-f0-9]{64})  ([^/\\\r\n]+)$/.exec(line);
    if(!match||map.has(match[2])) throw new Error("SHA256SUMS has an invalid or duplicate entry");
    map.set(match[2],match[1]);
  }
  if(map.size!==dataFiles.length||dataFiles.some(name=>!map.has(name))) throw new Error("SHA256SUMS must list exactly the present runtime payload files");
  return map;
}

async function verifyFiles(root:string) {
  const names=await runtimeFileNames(root),dataFiles=names.filter(name=>name!=="SHA256SUMS");
  const files=new Map<string,Buffer>();
  for(const name of names) {
    const path=join(root,name),stat=await lstat(path).catch(()=>null);
    if(!stat?.isFile()||stat.isSymbolicLink()) throw new Error(`Missing or unsafe runtime file: ${name}`);
    const bytes=await readFile(path);
    if(bytes.length===0) throw new Error(`Empty runtime file: ${name}`);
    if(TEXT_FILES.has(name)) checkText(name,bytes.toString("utf8"));
    files.set(name,bytes);
  }
  const sums=parseChecksums(files.get("SHA256SUMS")!.toString("utf8"),dataFiles);
  for(const name of dataFiles) if(sha(files.get(name)!)!==sums.get(name)) throw new Error(`SHA256SUMS mismatch: ${name}`);
  return {files,sums,names,dataFiles};
}

async function verifyPet(root:string,expectedId:RuntimePetId) {
  const pet=JSON.parse(await readFile(join(root,"pet.json"),"utf8")) as Record<string,unknown>;
  if(pet.id!==expectedId||pet.spriteVersionNumber!==2||pet.spritesheetPath!=="spritesheet.webp"||
    typeof pet.displayName!=="string"||!pet.displayName.trim()||typeof pet.description!=="string"||
    !pet.description.trim()||/[\r\n]/.test(pet.description)) {
    throw new Error(`pet.json must identify ${expectedId}, use sprite v2, and provide a one-line story`);
  }
  const c=await contract(),atlas=await decode(join(root,"spritesheet.webp"),c);
  const validation=validateAtlas(atlas,c);
  if(!validation.valid) throw new Error(`Invalid runtime atlas: ${validation.problems.join("; ")}`);
  return {id:pet.id,spriteVersionNumber:pet.spriteVersionNumber,atlasRgbaSha256:sha(atlas.pixels)};
}

/** A preview manifest must not be bundled with scripts targeting official Louis. */
function verifyInstallerTargets(files:Map<string,Buffer>,id:RuntimePetId) {
  for(const name of ["install.sh","uninstall.sh"]){
    const script=files.get(name)!.toString("utf8"),targets=[...script.matchAll(/^louis_target="([^"\r\n]+)"\s*$/gm)].map(m=>m[1]);
    const expected=name==="install.sh"?`$louis_pets/${id}`:`$louis_root/pets/${id}`;
    if(targets.length!==1||targets[0]!==expected)throw new Error(`${name} target does not match pet ID ${id}`);
    if(id==="louis-motion-preview"&&/(?:^|[^A-Za-z0-9_-])louis(?=$|[^A-Za-z0-9_-])/m.test(script))throw new Error(`${name} retains an official louis path or backup reference`);
  }
}

export async function packageRuntime(output:string,root=join(import.meta.dir,".."),options:{petId?:RuntimePetId}={}) {
  const source=resolve(root),archive=resolve(output);
  const id=runtimePetId(options.petId??"louis");
  if(!archive.toLowerCase().endsWith(".zip")) throw new Error("Output must be a .zip path");
  if(await lstat(archive).catch(()=>null)) throw new Error(`Output already exists: ${archive}`);
  const {files,sums,names,dataFiles}=await verifyFiles(source);
  const pet=await verifyPet(source,id);
  verifyInstallerTargets(files,id);
  const stage=await mkdtemp(join(dirname(archive),".louis-package-"));
  try {
    // Fixed order, mode and DOS-compatible UTC timestamp make archive metadata reproducible.
    // Apply only to temporary copies. Never alter the source package or its file bytes.
    const timestamp=new Date("2000-01-01T00:00:00.000Z");
    for(const name of names) {
      const staged=join(stage,name);
      await copyFile(join(source,name),staged,constants.COPYFILE_EXCL);
      await chmod(staged,0o644);
      await utimes(staged,timestamp,timestamp);
    }
    const stagedZip=join(stage,"runtime.zip");
    await run(["zip","-q","-X",stagedZip,...names],stage);
    const entries=(await run(["unzip","-Z","-1",stagedZip])).trimEnd().split(/\r?\n/);
    if(entries.length!==names.length||entries.some((name,i)=>name!==names[i])) {
      throw new Error(`ZIP entries differ from runtime allowlist: ${entries.join(", ")}`);
    }
    const extracted=join(stage,"extracted");
    await run(["unzip","-q",stagedZip,"-d",extracted]);
    const extractedNames=(await readdir(extracted)).sort();
    if(JSON.stringify(extractedNames)!==JSON.stringify([...names].sort())) throw new Error("Extracted archive has unexpected files");
    for(const name of names) {
      const stat=await lstat(join(extracted,name));
      if(!stat.isFile()||stat.isSymbolicLink()||sha(await readFile(join(extracted,name)))!==sha(files.get(name)!)) {
        throw new Error(`Extracted archive changed ${name}`);
      }
    }
    const archiveSha256=sha(await readFile(stagedZip));
    await link(stagedZip,archive); // Same filesystem, atomic and refuses an existing destination.
    return {archive,archiveSha256,manifest:{files:dataFiles.map(name=>({name,sha256:sums.get(name)})),checksumFile:{name:"SHA256SUMS",sha256:sha(files.get("SHA256SUMS")!)},pet}};
  } finally {await rm(stage,{recursive:true,force:true});}
}

if(import.meta.main) {
  const args=process.argv.slice(2);
  try{
    if(!args[0]||args.length%2!==1)throw new Error("Usage: bun tools/package.ts <output.zip> [--root <source-folder>] [--pet-id louis|louis-motion-preview]");
    let root:string|undefined,id:RuntimePetId="louis";const seen=new Set<string>();
    for(let i=1;i<args.length;i+=2){if(seen.has(args[i])||!args[i+1]||!["--root","--pet-id"].includes(args[i]))throw new Error("Invalid or duplicate package option");seen.add(args[i]);if(args[i]==="--root")root=args[i+1];else id=runtimePetId(args[i+1]);}
    console.log(JSON.stringify(await packageRuntime(args[0],root,{petId:id}),null,2));
  }catch(e){console.error(JSON.stringify({error:String((e as Error).message??e)}));process.exitCode=1;}
}
