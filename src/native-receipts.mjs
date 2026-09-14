import { mkdir, readFile, open, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const MAX_AGE = 24 * 3600000;
const MAX_BYTES = 256 * 1024 * 1024;

// A started receipt is deliberately not replayed after a crash: effects may have
// partly reached the old JSON ledgers. Preserve the encrypted event and stop new
// admissions until it is reconciled instead of charging the caller a second time.
export class NativeReceipts {
  static async open(root) {
    await mkdir(root, {recursive:true,mode:0o700});
    const dbPath=join(root,'receipts.sqlite'), keyPath=join(root,'encryption.key');
    let key;
    try { key=await readFile(keyPath); } catch(e) {
      if(e.code!=='ENOENT')throw e;
      try { await lstat(dbPath); throw new Error('Native receipt key missing; preserve the database'); } catch(e) {if(e.code!=='ENOENT')throw e;}
      const f=await open(keyPath,'wx',0o600);try {key=randomBytes(32);await f.writeFile(key);await f.sync();}finally{await f.close();}
    }
    if(key.length!==32)throw new Error('Native receipt key invalid');
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(dbPath);await chmod(dbPath,0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, payload BLOB); CREATE INDEX IF NOT EXISTS receipt_age ON receipts(at); CREATE TABLE IF NOT EXISTS policies (revision TEXT PRIMARY KEY, payload BLOB NOT NULL, at INTEGER NOT NULL);');
    if(process.platform!=='win32'){const dir=await open(root,'r');try{await dir.sync();}finally{await dir.close();}}
    const store=new NativeReceipts(db,key);
    store.blocked=Number(db.prepare("SELECT count(*) n FROM receipts WHERE state='started'").get().n)>0;
    return store;
  }
  constructor(db,key) {this.db=db;this.key=key;this.blocked=false;this.lastPrune=0;}
  encrypt(value) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),data]);
  }
  decrypt(raw) {
    const b=Buffer.from(raw),cipher=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));cipher.setAuthTag(b.subarray(12,28));
    return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString());
  }
  prune() {
    const now=Date.now();if(now-this.lastPrune<60000)return;
    this.db.prepare("DELETE FROM receipts WHERE state='done' AND at < ?").run(now-MAX_AGE-2*3600000);
    this.db.prepare('DELETE FROM policies WHERE at < ?').run(now-2*MAX_AGE);
    this.lastPrune=now;
  }
  capacity() {
    const page=this.db.prepare('PRAGMA page_size').get().page_size;
    const pages=this.db.prepare('PRAGMA page_count').get().page_count;
    const free=this.db.prepare('PRAGMA freelist_count').get().freelist_count;
    if((pages-free)*page>MAX_BYTES){this.blocked=true;this.blockedReason='capacity';throw new Error('native_receipts_capacity');}
  }
  policy(revision) {
    const row=this.db.prepare('SELECT payload FROM policies WHERE revision=?').get(revision);
    return row?this.decrypt(row.payload):null;
  }
  savePolicy(revision,policy) {
    this.prune();this.capacity();
    this.db.prepare('INSERT INTO policies(revision,payload,at) VALUES(?,?,?) ON CONFLICT(revision) DO UPDATE SET at=excluded.at').run(revision,this.encrypt(policy),Date.now());
  }
  async apply(event,digest,action,flush) {
    const id=event.id+':'+event.kind;
    const prior=this.db.prepare('SELECT digest,state FROM receipts WHERE id=?').get(id);
    if(prior) {
      if(prior.digest!==digest)throw new Error('native_receipt_conflict');
      if(prior.state==='done')return;
      throw new Error('native_receipt_reconciliation_required');
    }
    if(this.blocked)throw new Error('native_receipt_reconciliation_required');
    const at=event.receiptAt ?? Date.now();
    if(!Number.isSafeInteger(at)||at<Date.now()-MAX_AGE||at>Date.now()+60000)throw new Error('native_receipt_expired');
    this.prune();this.capacity();
    this.db.prepare('INSERT INTO receipts(id,digest,state,at,payload) VALUES(?,?,?,?,?)').run(id,digest,'started',at,this.encrypt(event));
    try {
      await action();await flush();
      this.db.prepare("UPDATE receipts SET state='done',payload=NULL WHERE id=?").run(id);
    }catch(error){this.blocked=true;throw error;}
  }
  status() {
    const pending=this.db.prepare("SELECT id,at FROM receipts WHERE state='started' ORDER BY at LIMIT 20").all();
    return {blocked:this.blocked, reason:this.blockedReason || (this.blocked?'reconciliation':null),pendingReconciliation:this.blocked?Number(this.db.prepare("SELECT count(*) n FROM receipts WHERE state='started'").get().n):0,sample:pending};
  }
  close(){this.db.close();}
}
