import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRuntime, RUNTIME_FILES } from "./package";
import { updateChecksums } from "./update-checksums";
import { previewInstaller } from "./stage-review-package";

const repo=join(import.meta.dir,"../fixtures/runtime");
const sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const license="Fixture-only license text. This is not a release license.\n";
// Both terms are synthetic in transport fixtures; release builders copy canonical texts.
let dir:string;
beforeAll(async()=>{dir=await mkdtemp(join(tmpdir(),"louis-package-test-"));});
afterAll(async()=>{if(dir) await rm(dir,{recursive:true,force:true});});

async function fixture(withLicense=false) {
  const source=await mkdtemp(join(dir,"source-"));
  for(const name of RUNTIME_FILES.filter(name=>name!=="SHA256SUMS")) await copyFile(join(repo,name),join(source,name));
  if(withLicense) for(const name of ["LICENSE","LICENSE-ARTWORK"]) await writeFile(join(source,name),license);
  await updateChecksums(source);
  await mkdir(join(source,"private"));
  await writeFile(join(source,"private","reference-photo.jpg"),"PRIVATE_DO_NOT_PACK");
  await writeFile(join(source,"SPEC.md"),"Source-only requirements. PRIVATE_DO_NOT_PACK.");
  return source;
}

async function unzip(args:string[]) {
  const proc=Bun.spawn(["unzip",...args],{stdout:"pipe",stderr:"pipe"});
  const [output,error,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  expect({code,error}).toEqual({code:0,error:""});
  return output;
}

for(const withLicense of [false,true]) test(`ZIP preserves its exact allowlist ${withLicense?"with":"without"} LICENSE`,async()=>{
  const source=await fixture(withLicense),output=join(source,"louis.zip");
  const result=await packageRuntime(output,source);
  const names=withLicense?[...RUNTIME_FILES.filter(name=>name!=="SHA256SUMS"),"LICENSE","LICENSE-ARTWORK","SHA256SUMS"]:[...RUNTIME_FILES];
  expect(result.archiveSha256).toBe(sha(await readFile(output)));
  expect((await unzip(["-Z","-1",output])).trimEnd().split(/\r?\n/)).toEqual(names);
  expect(result.manifest.files.map(x=>x.name)).toEqual(names.filter(name=>name!=="SHA256SUMS"));
  const extracted=join(source,"readback");
  await unzip(["-q",output,"-d",extracted]);
  for(const name of names) expect(sha(await readFile(join(extracted,name)))).toBe(sha(await readFile(join(source,name))));
  if(withLicense) expect(result.manifest.files.find(x=>x.name==="LICENSE")?.sha256).toBe(sha(Buffer.from(license)));
  else expect(await Bun.file(join(extracted,"LICENSE")).exists()).toBe(false);
  const archiveBefore=await readFile(output);
  await expect(packageRuntime(output,source)).rejects.toThrow("already exists");
  expect(await readFile(output)).toEqual(archiveBefore);
},30_000);

for(const name of ["README.md","LICENSE","LICENSE-ARTWORK"]) test(`changed ${name} rejects before creating an archive`,async()=>{
  const source=await fixture(true),output=join(source,"bad.zip");
  await writeFile(join(source,name),(await readFile(join(source,name),"utf8"))+"\nChanged after checksums.\n");
  await expect(packageRuntime(output,source)).rejects.toThrow(`SHA256SUMS mismatch: ${name}`);
  expect(await Bun.file(output).exists()).toBe(false);
});

test("LICENSE presence must agree with checksum entries",async()=>{
  const source=await fixture(),output=join(source,"bad.zip");
  await writeFile(join(source,"LICENSE"),license);
  await expect(packageRuntime(output,source)).rejects.toThrow("both LICENSE and LICENSE-ARTWORK");
  await writeFile(join(source,"LICENSE-ARTWORK"),license);
  await expect(packageRuntime(output,source)).rejects.toThrow("exactly the present runtime payload files");
  await updateChecksums(source);
  await rm(join(source,"LICENSE"));
  await expect(packageRuntime(output,source)).rejects.toThrow("both LICENSE and LICENSE-ARTWORK");
  await rm(join(source,"LICENSE-ARTWORK"));
  await expect(packageRuntime(output,source)).rejects.toThrow("exactly the present runtime payload files");
  expect(await Bun.file(output).exists()).toBe(false);
  const updated=await updateChecksums(source);
  expect(updated.files).toBe(RUNTIME_FILES.length-1);
  expect(await readFile(join(source,"SHA256SUMS"),"utf8")).not.toContain("LICENSE");
});

test("a checksum cannot widen the runtime allowlist",async()=>{
  const source=await fixture(true),output=join(source,"bad.zip");
  const sums=await readFile(join(source,"SHA256SUMS"),"utf8");
  await writeFile(join(source,"SHA256SUMS"),sums+`${sha(await readFile(join(source,"SPEC.md")))}  SPEC.md\n`);
  await expect(packageRuntime(output,source)).rejects.toThrow("exactly the present runtime payload files");
  expect(await Bun.file(output).exists()).toBe(false);
});

test("optional LICENSE receives the runtime text privacy check",async()=>{
  const source=await fixture(true),output=join(source,"bad.zip");
  await writeFile(join(source,"LICENSE"),"Fixture text with a private path: /home/example/private/notes\n");
  await updateChecksums(source);
  await expect(packageRuntime(output,source)).rejects.toThrow("LICENSE contains an absolute user-home path");
  expect(await Bun.file(output).exists()).toBe(false);
});

for(const name of ["pet.json","LICENSE","LICENSE-ARTWORK"]) test(`symlinked ${name} is rejected by packaging and checksum updates`,async()=>{
  const source=await fixture(true),output=join(source,"bad.zip");
  const original=await readFile(join(source,name)),target=join(source,"outside-target");
  await writeFile(target,original);
  await rm(join(source,name));await symlink(target,join(source,name));
  const sums=await readFile(join(source,"SHA256SUMS"));
  await expect(packageRuntime(output,source)).rejects.toThrow(/unsafe/i);
  await expect(updateChecksums(source)).rejects.toThrow(/unsafe/i);
  expect(await readFile(join(source,"SHA256SUMS"))).toEqual(sums);
  expect(await readFile(target)).toEqual(original);
  expect(await Bun.file(output).exists()).toBe(false);
});

test("a dangling LICENSE symlink is not treated as absence",async()=>{
  const source=await fixture(),output=join(source,"bad.zip");
  await symlink(join(source,"does-not-exist"),join(source,"LICENSE"));
  await expect(packageRuntime(output,source)).rejects.toThrow("Unsafe optional runtime file: LICENSE");
  await expect(updateChecksums(source)).rejects.toThrow("Unsafe optional runtime file: LICENSE");
});

test("checksum refresh does not write through a symlink",async()=>{
  const source=await fixture(),target=join(source,"outside-checksums");
  await writeFile(target,"leave this file alone\n");
  await rm(join(source,"SHA256SUMS"));await symlink(target,join(source,"SHA256SUMS"));
  await expect(updateChecksums(source)).rejects.toThrow("Unsafe checksum output: SHA256SUMS");
  expect(await readFile(target,"utf8")).toBe("leave this file alone\n");
});

async function previewFixture(){
  const source=await fixture(),pet=JSON.parse(await readFile(join(source,"pet.json"),"utf8"));
  pet.id="louis-motion-preview";pet.displayName="Louis Motion Preview";
  await writeFile(join(source,"pet.json"),JSON.stringify(pet)+"\n");
  for(const name of ["install.sh","uninstall.sh"])await writeFile(join(source,name),previewInstaller(await readFile(join(source,name),"utf8")));
  await updateChecksums(source);return source;
}

test("preview packaging requires explicit ID and keeps matching lifecycle scripts",async()=>{
  const source=await previewFixture(),output=join(source,"preview.zip");
  await expect(packageRuntime(output,source)).rejects.toThrow("identify louis");
  expect(await Bun.file(output).exists()).toBe(false);
  const result=await packageRuntime(output,source,{petId:"louis-motion-preview"});
  expect(result.manifest.pet.id).toBe("louis-motion-preview");
  const metadata=JSON.parse(await unzip(["-p",output,"pet.json"]));expect(metadata.id).toBe("louis-motion-preview");
  const script=await unzip(["-p",output,"install.sh"]);expect(script).toContain('louis_target="$louis_pets/louis-motion-preview"');expect(script).not.toContain('"$louis_backup/louis"');
},30000);

test("preview metadata cannot be packaged with an official installer or stale official backup path",async()=>{
  const source=await previewFixture(),output=join(source,"bad.zip"),valid=await readFile(join(source,"install.sh"),"utf8");
  await copyFile(join(repo,"install.sh"),join(source,"install.sh"));await updateChecksums(source);
  await expect(packageRuntime(output,source,{petId:"louis-motion-preview"})).rejects.toThrow("target does not match");
  await writeFile(join(source,"install.sh"),valid.replace('"$louis_backup/louis-motion-preview"','"$louis_backup/louis"'));await updateChecksums(source);
  await expect(packageRuntime(output,source,{petId:"louis-motion-preview"})).rejects.toThrow("official louis path");
  expect(await Bun.file(output).exists()).toBe(false);
});

test("official metadata cannot silently adopt preview installers and arbitrary IDs are rejected",async()=>{
  const source=await fixture(),output=join(source,"bad.zip");
  await writeFile(join(source,"uninstall.sh"),previewInstaller(await readFile(join(source,"uninstall.sh"),"utf8")));await updateChecksums(source);
  await expect(packageRuntime(output,source)).rejects.toThrow("target does not match");
  await expect(packageRuntime(output,source,{petId:"../louis" as any})).rejects.toThrow("Pet ID must be");
  expect(await Bun.file(output).exists()).toBe(false);
});

test("artwork terms cannot be silently dropped or replaced with a dangling link",async()=>{
 const source=await fixture(true),output=join(source,"bad.zip");
 await rm(join(source,"LICENSE-ARTWORK"));
 await expect(packageRuntime(output,source)).rejects.toThrow("both LICENSE and LICENSE-ARTWORK");
 await expect(updateChecksums(source)).rejects.toThrow("both LICENSE and LICENSE-ARTWORK");
 await symlink(join(source,"missing-art-terms"),join(source,"LICENSE-ARTWORK"));
 await expect(packageRuntime(output,source)).rejects.toThrow("Unsafe optional runtime file: LICENSE-ARTWORK");
 expect(await Bun.file(output).exists()).toBe(false);
});
