import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash, randomUUID } from 'node:crypto';
import { zipSync, Unzip, UnzipInflate } from 'fflate';
import type { BackupPreview } from '../../src/features/runtime/api';

export const BACKUP_LIMIT = 512 * 1024 * 1024;
export const BACKUP_FILE_LIMIT = 128 * 1024 * 1024;
const MAGIC = Buffer.from('MYAGENT-BACKUP-2\n');
export function safeArchivePath(name: string): boolean {
  return Boolean(name) && name.length < 1000 && !name.includes('\\') && !name.includes('\0') && !name.startsWith('/') && !/^[a-z]:/i.test(name) && !name.split('/').some(p => p === '..' || p === '.' || !p || /[\x00-\x1f:]/.test(p) || /[.\s]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(p));
}
export function packEncrypted(files: Record<string, Uint8Array>, password: string): Buffer {
  if (password.length < 8 || password.length > 1024) throw new Error('备份口令需要 8 到 1024 个字符');
  let total = 0;
  for (const [name, bytes] of Object.entries(files)) { if (!safeArchivePath(name) || bytes.length > BACKUP_FILE_LIMIT) throw new Error(`文件名无效或单文件超过 128 MB：${name}`); total += bytes.length; }
  if (total > BACKUP_LIMIT) throw new Error('备份内容超过 512 MB，请先整理大附件');
  const zip = zipSync(files, { level: 6 });
  const salt = randomBytes(16); const iv = randomBytes(12); const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(zip), cipher.final()]); key.fill(0);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]);
}
export function unpackEncrypted(buffer: Buffer, password: string): Record<string, Uint8Array> {
  if (password.length < 8 || password.length > 1024 || buffer.length > BACKUP_LIMIT + 8 * 1024 * 1024 || buffer.length < MAGIC.length + 44 || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('备份文件格式无效或超出 512 MB 限制');
  const offset = MAGIC.length; const key = scryptSync(password, buffer.subarray(offset,offset+16),32);
  const cipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(offset+16,offset+28)); cipher.setAAD(MAGIC); cipher.setAuthTag(buffer.subarray(offset+28,offset+44));
  let zip: Buffer;
  try { zip = Buffer.concat([cipher.update(buffer.subarray(offset+44)), cipher.final()]); } catch { throw new Error('口令错误或备份文件已损坏'); } finally { key.fill(0); }
  return unpackBoundedZip(zip);
}
export function unpackBoundedZip(zip: Uint8Array, allowEmpty = false): Record<string,Uint8Array> {
  if(zip.length > BACKUP_LIMIT + 8 * 1024 * 1024) throw new Error('归档超出体积限制');
  const files: Record<string, Uint8Array> = Object.create(null); let total = 0; let entries = 0; let fault: Error | undefined;
  const unzip = new Unzip(file => {
    if (!safeArchivePath(file.name) || ++entries > 10000 || file.originalSize === undefined || file.originalSize > BACKUP_FILE_LIMIT || files[file.name]) { fault = new Error('归档路径、条目数量或文件体积无效'); file.terminate(); return; }
    total += file.originalSize;
    if (total > BACKUP_LIMIT) { fault = new Error('备份解压后超过 512 MB'); file.terminate(); return; }
    const chunks: Uint8Array[] = []; let size = 0;
    file.ondata = (error, data, final) => {
      if (error) { fault = error; return; }
      size += data.length; if (size > BACKUP_FILE_LIMIT || size > (file.originalSize || 0)) { fault = new Error('解压数据长度异常'); file.terminate(); return; }
      chunks.push(data);
      if (final) { const joined = new Uint8Array(size); let at = 0; for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; } files[file.name] = joined; }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Bound each inflate turn: a forged size header cannot cause one huge allocation before ondata validates output.
  for(let offset=0;offset<zip.length;offset+=32*1024){unzip.push(zip.subarray(offset,Math.min(zip.length,offset+32*1024)),offset+32*1024>=zip.length);if(fault)throw fault;}
  if (fault) throw fault;
  if (!allowEmpty && !Object.keys(files).length) throw new Error('备份为空'); return files;
}
export function mergePreservingCurrent(current: unknown, imported: unknown, prefix = '', conflicts: string[] = []): unknown {
  if (JSON.stringify(current) === JSON.stringify(imported)) return current;
  if (Array.isArray(current) && Array.isArray(imported)) {
    const all = [...current];
    for (const item of imported) {
      const id = item && typeof item === 'object' && 'id' in item ? String(item.id) : undefined;
      const old = id ? all.find(v => v && typeof v === 'object' && 'id' in v && String(v.id) === id) : all.find(v => JSON.stringify(v) === JSON.stringify(item));
      if (old === undefined) all.push(item); else if (id && JSON.stringify(old) !== JSON.stringify(item)) conflicts.push(`${prefix}[${id}]`);
    }
    return all;
  }
  if (current && imported && typeof current === 'object' && typeof imported === 'object' && !Array.isArray(current) && !Array.isArray(imported)) {
    const output: Record<string, unknown> = { ...(imported as Record<string,unknown>) };
    for (const [key,value] of Object.entries(current)) output[key] = key in output ? mergePreservingCurrent(value, output[key], prefix ? `${prefix}.${key}` : key, conflicts) : value;
    return output;
  }
  conflicts.push(prefix); return current;
}
function walkStrings(node: unknown, callback: (value: string) => void): void {
  if (typeof node === 'string') callback(node); else if (Array.isArray(node)) node.forEach(v => walkStrings(v,callback)); else if (node && typeof node === 'object') Object.values(node).forEach(v => walkStrings(v,callback));
}
function transformStrings(node: unknown, callback: (value: string) => string): unknown {
  if (typeof node === 'string') return callback(node);
  if (Array.isArray(node)) return node.map(v => transformStrings(v, callback));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key,value]) => [key,transformStrings(value,callback)]));
  return node;
}
export function isRepositoryPath(name:string):boolean{return /^persist\/[a-z0-9._-]+\.json$/i.test(name)||['runtime/state.json','document-workbench/versions.json','media-workbench/versions.json'].includes(name);}
interface BackupManifest { version: 2; createdAt: number; repositories: string[]; attachments: Array<{ archive: string; original: string; root: string; relative: string; hash: string }>; checksums: Record<string,string> }
interface PreparedBackup { preview: BackupPreview; manifest: BackupManifest; files: Record<string,Uint8Array>; fingerprint: string }
export interface BackupOptions { userData: string; managedRoots: Record<string,string>; reveal: (value: unknown) => unknown; protect: (value: unknown) => unknown; revealRuntime: (value: unknown) => unknown; protectRuntime: (value: unknown) => unknown }
export class BackupService {
  private previews = new Map<string,PreparedBackup>();
  constructor(private options: BackupOptions) {}
  private async repositoryFiles(): Promise<Record<string,Uint8Array>> {
    const output: Record<string,Uint8Array> = {};
    for (const name of (await fs.readdir(path.join(this.options.userData,'persist')).catch(()=>[])).filter(n=>/^[a-z0-9._-]+\.json$/i.test(n))) output[`persist/${name}`] = await fs.readFile(path.join(this.options.userData,'persist',name));
    const runtime = await fs.readFile(path.join(this.options.userData,'runtime','state.json')).catch(()=>null); if (runtime) output['runtime/state.json'] = runtime;
    for(const name of ['document-workbench/versions.json','media-workbench/versions.json']){const data=await fs.readFile(path.join(this.options.userData,name)).catch(()=>null);if(data)output[name]=data;}
    return output;
  }
  private reveal(name: string, bytes: Uint8Array): unknown { const json = JSON.parse(Buffer.from(bytes).toString('utf8')); return name.startsWith('runtime/') ? this.options.revealRuntime(json) : this.options.reveal(json); }
  private protect(name: string, value: unknown): unknown { return name.startsWith('runtime/') ? this.options.protectRuntime(value) : this.options.protect(value); }
  async export(password: string): Promise<{ bytes: Buffer; files: number }> {
    const files = await this.repositoryFiles(); const attachments: BackupManifest['attachments'] = []; const warnings: string[] = [];
    for (const [name,bytes] of Object.entries(files)) {
      const value = this.reveal(name, bytes);
      walkStrings(value, text => { if (text.startsWith('enc:v1:') || text.startsWith('runtime:secret:v1:')) throw new Error('有密钥无法在本机解密，备份已停止，避免迁移后密钥失效'); });
      files[name] = Buffer.from(JSON.stringify(value));
    }
    const addDirectory = async (rootName: string, root: string, dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])) {
        const full = path.join(dir,entry.name); if (entry.isSymbolicLink()) { warnings.push('跳过符号链接'); continue; }
        if (entry.isDirectory()) await addDirectory(rootName,root,full);
        else if (entry.isFile()) {
          if(files[path.relative(this.options.userData,full).split(path.sep).join('/')])continue;
          const real = await fs.realpath(full); const rootReal = await fs.realpath(root);
          if (path.relative(rootReal,real).startsWith('..')) throw new Error('附件目录包含越界路径');
          const stat = await fs.stat(real); if (stat.size > BACKUP_FILE_LIMIT) throw new Error(`附件超过 128 MB：${entry.name}`);
          const bytes = await fs.readFile(real); const relative = path.relative(root,full).split(path.sep).join('/'); const archive = `attachments/${rootName}/${relative}`;
          files[archive] = bytes; attachments.push({ archive,original: full,root: rootName,relative,hash: createHash('sha256').update(bytes).digest('hex') });
          if (Object.keys(files).length > 10000 || Object.values(files).reduce((sum,v)=>sum+v.length,0)>BACKUP_LIMIT) throw new Error('备份超过条目数量或 512 MB 上限');
        }
      }
    };
    for (const [name,root] of Object.entries(this.options.managedRoots)) await addDirectory(name,root,root);
    if (warnings.length) throw new Error('管理附件目录中含有符号链接，请移除后再备份');
    const checksums = Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,createHash('sha256').update(bytes).digest('hex')]));
    files['manifest.json'] = Buffer.from(JSON.stringify({version:2,createdAt:Date.now(),repositories:Object.keys(files).filter(isRepositoryPath),attachments,checksums} satisfies BackupManifest));
    return {bytes:packEncrypted(files,password),files:Object.keys(files).length-1};
  }
  private async fingerprint(): Promise<string> { return createHash('sha256').update(JSON.stringify(Object.entries(await this.repositoryFiles()).map(([name,bytes])=>[name,createHash('sha256').update(bytes).digest('hex')]))).digest('hex'); }
  async preview(bytes: Buffer, password: string): Promise<BackupPreview> {
    const files = unpackEncrypted(bytes,password); const manifest = JSON.parse(Buffer.from(files['manifest.json']||[]).toString('utf8')) as BackupManifest;
    if (manifest.version!==2 || !Array.isArray(manifest.repositories) || !Array.isArray(manifest.attachments) || !manifest.checksums || manifest.repositories.length>1000 || manifest.attachments.length>10000) throw new Error('备份清单格式不兼容');
    for (const [name,value] of Object.entries(files)) if (name !== 'manifest.json' && (!manifest.checksums[name] || createHash('sha256').update(value).digest('hex')!==manifest.checksums[name])) throw new Error('备份校验失败');
    for (const name of manifest.repositories) if (!isRepositoryPath(name) || !files[name]) throw new Error('备份仓库路径无效');
    for (const item of manifest.attachments) if (!this.options.managedRoots[item.root] || !safeArchivePath(item.relative) || item.archive!==`attachments/${item.root}/${item.relative}` || !files[item.archive] || item.hash!==manifest.checksums[item.archive]) throw new Error('附件清单路径或校验值无效');
    const current = await this.repositoryFiles(); const conflicts: string[] = []; const warnings: string[] = [];
    for (const name of manifest.repositories) { const value = JSON.parse(Buffer.from(files[name]).toString('utf8')); if (current[name]) {try{mergePreservingCurrent(this.reveal(name,current[name]),value,name,conflicts);}catch{conflicts.push(`${name} (本机文件损坏)`);warnings.push(`${name} 不能合并，请选择使用备份覆盖对应仓库。`);}} }
    for (const item of manifest.attachments) if (await fs.stat(path.join(this.options.managedRoots[item.root],item.relative)).catch(()=>null)) conflicts.push(item.archive);
    // External project/knowledge directory references cannot be silently followed on another computer.
    warnings.push('外部知识库资料目录保留引用，需在新电脑重新授权；导入的计划暂停，MCP 不自动启动。');
    const preview: BackupPreview = {id:randomUUID(),createdAt:manifest.createdAt,files:Object.keys(files).length-1,bytes:Object.values(files).reduce((n,v)=>n+v.length,0),conflicts:conflicts.slice(0,1000),warnings,repositories:manifest.repositories};
    this.previews.clear(); this.previews.set(preview.id,{preview,manifest,files,fingerprint:await this.fingerprint()}); return preview;
  }
  async restore(id: string, mode: 'merge'|'replace'): Promise<{restartRequired:boolean;rollbackId:string}> {
    const prepared = this.previews.get(id); if (!prepared) throw new Error('导入预览已失效，请重新选择备份');
    if (await this.fingerprint()!==prepared.fingerprint) throw new Error('预览后本机数据已变化，请重新预检后恢复');
    if (!['merge','replace'].includes(mode)) throw new Error('恢复方式无效');
    const rollbackId = await this.snapshot('before-restore'); const current = await this.repositoryFiles(); const added: string[] = [];
    try {
      const remap = new Map<string,string>();
      for (const item of prepared.manifest.attachments) {
        const base = path.join(this.options.managedRoots[item.root],item.relative); await this.ensureSafeTarget(this.options.managedRoots[item.root],base); let target = base;
        const existing = await fs.readFile(base).catch(()=>null);
        if (existing && createHash('sha256').update(existing).digest('hex')!==item.hash) target = path.join(path.dirname(base),`${path.parse(base).name}-import-${item.hash.slice(0,10)}${path.extname(base)}`);
        await this.ensureSafeTarget(this.options.managedRoots[item.root],target);
        await this.assertManagedTarget(item.root,target);
        if (!await fs.stat(target).catch(()=>null)) { await fs.writeFile(target,prepared.files[item.archive],{flag:'wx',mode:0o600}); added.push(target); }
        remap.set(item.original,target);
      }
      for (const name of prepared.manifest.repositories) {
        let imported = JSON.parse(Buffer.from(prepared.files[name]).toString('utf8'));
        imported = transformStrings(imported,text=>{ for (const [old,target] of remap) text = text.split(old).join(target).split(`file://${encodeURI(old)}`).join(`file://${encodeURI(target)}`); return text; });
        if (name==='runtime/state.json') { imported.allowedDirectories=[]; imported.schedules=(imported.schedules||[]).map((s:object)=>({...s,enabled:false})); imported.connections=(imported.connections||[]).map((c:object)=>({...c,enabled:false})); imported.tasks=(imported.tasks||[]).map((t:{status:string})=>({...t,status:['running','awaiting_action'].includes(t.status)?'interrupted':t.status})); }
        const value = mode==='merge'&&current[name]?mergePreservingCurrent(this.reveal(name,current[name]),imported):imported;
        const target = path.join(this.options.userData,name); await this.ensureSafeTarget(this.options.userData,target); await this.assertUserTarget(target);
        const temp = `${target}.${randomUUID()}.tmp`; await fs.writeFile(temp,JSON.stringify(this.protect(name,value)),{mode:0o600}); await fs.rename(temp,target);
      }
      const receipt=added.map(file=>{const root=Object.entries(this.options.managedRoots).find(([,dir])=>{const relative=path.relative(dir,file);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);});if(!root)throw new Error('恢复附件根目录无效');return{root:root[0],relative:path.relative(root[1],file).split(path.sep).join('/'),hash:createHash('sha256').update(prepared.files[prepared.manifest.attachments.find(item=>remap.get(item.original)===file)!.archive]).digest('hex')};});
      await fs.writeFile(path.join(this.options.userData,'runtime','snapshots',`${rollbackId}.receipt.json`),JSON.stringify(receipt),{mode:0o600});
      this.previews.clear(); return {restartRequired:true,rollbackId};
    } catch(error) { await this.rollback(rollbackId); await Promise.allSettled(added.map(file=>fs.rm(file,{force:true}))); throw error; }
  }
  private async ensureSafeTarget(root:string,target:string):Promise<void>{
    const relative=path.relative(path.resolve(root),path.resolve(target));if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('恢复目标目录越界');
    await fs.mkdir(root,{recursive:true});const rootStat=await fs.lstat(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new Error('恢复根目录不能是符号链接');
    let current=root;const parts=relative.split(path.sep);for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);const info=await fs.lstat(current).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});if(info?.isSymbolicLink())throw new Error('恢复目标路径包含符号链接');if(i<parts.length-1){if(info&&!info.isDirectory())throw new Error('恢复目录被文件占用');if(!info)await fs.mkdir(current);}else if(info&&!info.isFile())throw new Error('恢复目标不是普通文件');}
  }
  private async assertManagedTarget(rootName:string,target:string): Promise<void> { const root=await fs.realpath(this.options.managedRoots[rootName]); const parent=await fs.realpath(path.dirname(target)); const rel=path.relative(root,parent); if(rel.startsWith('..')||path.isAbsolute(rel)) throw new Error('附件目标目录越界'); }
  private async assertUserTarget(target:string): Promise<void> { const root=await fs.realpath(this.options.userData); const parent=await fs.realpath(path.dirname(target)); const rel=path.relative(root,parent); if(rel.startsWith('..')||path.isAbsolute(rel)) throw new Error('仓库目标目录越界'); }
  async listSnapshots():Promise<Array<{id:string;createdAt:number;label:string}>> {
    const names=await fs.readdir(path.join(this.options.userData,'runtime','snapshots')).catch(()=>[]);
    return names.filter(name=>/^\d+-(upgrade|before-restore)-[a-z0-9]+\.zip$/.test(name)).sort().reverse().map(name=>({id:name.slice(0,-4),createdAt:Number(name.split('-')[0]),label:name.includes('-upgrade-')?'升级前快照':'恢复前快照'}));
  }
  async snapshot(label:string): Promise<string> {
    const files = await this.repositoryFiles(); if (Object.values(files).some(v=>v.length>BACKUP_FILE_LIMIT)||Object.values(files).reduce((sum,v)=>sum+v.length,0)>BACKUP_LIMIT) throw new Error('数据太大，无法建立回滚快照');
    const id=`${Date.now()}-${label}-${randomUUID().slice(0,8)}`; const dir=path.join(this.options.userData,'runtime','snapshots'); await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,`${id}.zip`),zipSync(files,{level:6}),{mode:0o600});
    const names=(await fs.readdir(dir)).filter(n=>n.endsWith('.zip')).sort(); for(const name of names.slice(0,-5)){await fs.rm(path.join(dir,name),{force:true});await fs.rm(path.join(dir,`${name.slice(0,-4)}.receipt.json`),{force:true});} return id;
  }
  async rollback(id:string):Promise<{restartRequired:boolean}> {
    if(!/^[a-z0-9-]+$/i.test(id)) throw new Error('回滚标识无效');
    // Local snapshots contain original keychain-encrypted repositories, never portable plaintext credentials.
    const archive=await fs.readFile(path.join(this.options.userData,'runtime','snapshots',`${id}.zip`));
    const restored=unpackBoundedZip(archive,true);
    for(const name of Object.keys(restored))if(!isRepositoryPath(name))throw new Error('快照路径无效');
    for(const [name,data] of Object.entries(restored)){const target=path.join(this.options.userData,name);await this.ensureSafeTarget(this.options.userData,target);await this.assertUserTarget(target);const temp=`${target}.${randomUUID()}.tmp`;await fs.writeFile(temp,data,{mode:0o600});await fs.rename(temp,target);}
    for(const name of Object.keys(await this.repositoryFiles()))if(!restored[name])await fs.rm(path.join(this.options.userData,name),{force:true});
    const receipt=JSON.parse(await fs.readFile(path.join(this.options.userData,'runtime','snapshots',`${id}.receipt.json`),'utf8').catch(()=> '[]')) as Array<{root:string;relative:string;hash:string}>;
    for(const item of receipt){const root=this.options.managedRoots[item.root];if(!root||!safeArchivePath(item.relative))throw new Error('回滚附件清单路径无效');const target=path.join(root,item.relative);await this.ensureSafeTarget(root,target);const current=await fs.readFile(target).catch(()=>null);if(current&&createHash('sha256').update(current).digest('hex')===item.hash)await fs.rm(target,{force:true});}
    return{restartRequired:true};
  }
}
