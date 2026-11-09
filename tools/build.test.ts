import{test,expect,afterAll,beforeAll}from'bun:test';
import{createHash}from'node:crypto';
import{mkdtemp,mkdir,copyFile,readFile,writeFile,rm,symlink,lstat}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join,resolve}from'node:path';
import{buildRuntime}from'./build';
import{RUNTIME_FILES}from'./package';
// License tests below use synthetic atlas inputs and never install a real pet.
const repo=resolve(import.meta.dir,'..'),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');let temp:string;
beforeAll(async()=>{temp=await mkdtemp(join(tmpdir(),'louis-source-build-'));});
afterAll(async()=>{await rm(temp,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(temp,'case-'));for(const name of ['.gitignore','install.sh','uninstall.sh'])await copyFile(join(repo,name),join(root,name));await copyFile(join(repo,'fixtures/runtime/spritesheet.webp'),join(root,'input.webp'));return{root,atlas:'input.webp',sha256:hash(await readFile(join(root,'input.webp'))),out:'dist/test',id:'louis-motion-preview' as const,allowUnlicensedFixtures:true};}
async function unzip(zip:string,args:string[]){const p=Bun.spawn(['unzip',...args,zip],{stdout:'pipe',stderr:'pipe'});const out=await new Response(p.stdout).text();expect(await p.exited).toBe(0);return out;}
test('explicit input reaches exactly the runtime allowlist and no real installation',async()=>{const f=await fixture(),r=await buildRuntime(f),runtime=join(f.root,f.out,'runtime');expect(r.artworkAccepted).toBe(false);expect(r.installed).toBe(false);expect(r.published).toBe(false);expect(await readFile(join(runtime,'spritesheet.webp'))).toEqual(await readFile(join(f.root,f.atlas)));expect(JSON.parse(await readFile(join(runtime,'pet.json'),'utf8')).id).toBe('louis-motion-preview');const entries=await unzip(join(f.root,f.out,'louis-motion-preview.zip'),['-Z','-1']);expect(entries.trim().split('\n')).toEqual([...RUNTIME_FILES]);expect(await lstat(join(f.root,'pets')).catch(()=>null)).toBeNull();},30000);
test('same input reproduces payload and ZIP bytes with fixed archive metadata',async()=>{const f=await fixture(),a=await buildRuntime(f),b=await buildRuntime({...f,out:'dist/second'});expect(a.atlasRgbaSha256).toBe(b.atlasRgbaSha256);expect(a.archiveSha256).toBe(b.archiveSha256);for(const name of RUNTIME_FILES)expect(await readFile(join(f.root,f.out,'runtime',name))).toEqual(await readFile(join(f.root,'dist/second/runtime',name)));const zip=await readFile(join(f.root,f.out,'louis-motion-preview.zip'));let entries=0;for(let i=0;i<zip.length-46;i++)if(zip.readUInt32LE(i)===0x02014b50){entries++;expect(zip.readUInt16LE(i+12)).toBe(0);expect(zip.readUInt16LE(i+14)).toBe(0x2821);expect((zip.readUInt32LE(i+38)>>>16)&0o777).toBe(0o644);}expect(entries).toBe(RUNTIME_FILES.length);},30000);
test('wrong hash rejects before any output',async()=>{const f=await fixture();await expect(buildRuntime({...f,sha256:'0'.repeat(64)})).rejects.toThrow('SHA256 mismatch');expect(await lstat(join(f.root,f.out)).catch(()=>null)).toBeNull();});
test('source mutation rejects the prior binding',async()=>{const f=await fixture();await writeFile(join(f.root,f.atlas),'changed');await expect(buildRuntime(f)).rejects.toThrow('SHA256 mismatch');});
test('synthetic input cannot escape output boundary or overwrite output',async()=>{const f=await fixture();await expect(buildRuntime({...f,out:'../outside'})).rejects.toThrow('below dist');await buildRuntime(f);await expect(buildRuntime(f)).rejects.toThrow('already exists');},30000);
test('symlinked input and output parents reject',async()=>{const f=await fixture();await symlink(join(f.root,f.atlas),join(f.root,'linked.webp'));await expect(buildRuntime({...f,atlas:'linked.webp'})).rejects.toThrow('ordinary file');await mkdir(join(f.root,'outside'));await symlink(join(f.root,'outside'),join(f.root,'dist'));await expect(buildRuntime(f)).rejects.toThrow('link or file');});
test('linked LICENSE rejects before output',async()=>{const f=await fixture();await writeFile(join(f.root,'notice'),'test only');await symlink(join(f.root,'notice'),join(f.root,'LICENSE'));await expect(buildRuntime(f)).rejects.toThrow('ordinary file');expect(await lstat(join(f.root,f.out)).catch(()=>null)).toBeNull();});

test('both canonical terms survive the runtime ZIP byte for byte',async()=>{
 const f=await fixture();
 for(const name of ['LICENSE','LICENSE-ARTWORK'])await copyFile(join(repo,name),join(f.root,name));
 const r=await buildRuntime(f),zip=join(f.root,f.out,'louis-motion-preview.zip');
 expect(r.licensePresent).toBe(true);expect(r.licenseFiles).toEqual(['LICENSE','LICENSE-ARTWORK']);
 const p=Bun.spawn(['unzip','-q',zip,'-d',join(f.root,'readback')],{stdout:'pipe',stderr:'pipe'});expect(await p.exited).toBe(0);
 for(const name of ['LICENSE','LICENSE-ARTWORK'])expect(await readFile(join(f.root,'readback',name))).toEqual(await readFile(join(repo,name)));
 expect(await readFile(join(f.root,'readback/README.md'),'utf8')).toContain('Artwork terms are in [LICENSE-ARTWORK](LICENSE-ARTWORK)');
},30000);
test('either missing term rejects before creating runtime output',async()=>{
 for(const name of ['LICENSE','LICENSE-ARTWORK']){
  const f=await fixture();await copyFile(join(repo,name),join(f.root,name));
  await expect(buildRuntime(f)).rejects.toThrow('Both LICENSE and LICENSE-ARTWORK');
  expect(await lstat(join(f.root,f.out)).catch(()=>null)).toBeNull();
 }
});
test('linked artwork terms reject before output',async()=>{
 const f=await fixture();await copyFile(join(repo,'LICENSE'),join(f.root,'LICENSE'));
 await symlink(join(repo,'LICENSE-ARTWORK'),join(f.root,'LICENSE-ARTWORK'));
 await expect(buildRuntime(f)).rejects.toThrow('ordinary file');
 expect(await lstat(join(f.root,f.out)).catch(()=>null)).toBeNull();
});

test('normal builds require licenses before creating output',async()=>{
 const f=await fixture();
 await expect(buildRuntime({...f,allowUnlicensedFixtures:false})).rejects.toThrow('Both LICENSE and LICENSE-ARTWORK');
 expect(await lstat(join(f.root,f.out)).catch(()=>null)).toBeNull();
});

test('preview sidecars are portable and exclude absolute local paths',async()=>{
 const f=await fixture();await buildRuntime(f);
 const body=await readFile(join(f.root,f.out,'runtime/preview.gif.json'),'utf8');
 expect(JSON.parse(body).output).toBe('preview.gif');
 expect(body).not.toContain(f.root);
},30000);
