// Offline recovery of ambiguous native receipts. Never replay an upstream call here.
import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const [action, ...args] = process.argv.slice(2);
const value = name => {const at=args.indexOf(name);return at<0?null:args[at+1];};
try {
  if(!['inspect','mark-applied','retry-unapplied'].includes(action))throw Error('用法：inspect | mark-applied | retry-unapplied --dir 目录；修改还需 --id、--digest 和 --confirm-offline');
  const root=resolve(value('--dir') || './data/native-receipts');
  const file=join(root,'receipts.sqlite');if(!(await stat(file)).isFile())throw Error('记录文件不存在');
  const db=new DatabaseSync(file,{readOnly:action==='inspect'});
  try {
    if(action==='inspect') {
      console.log(JSON.stringify({pending:db.prepare("SELECT id,digest,at FROM receipts WHERE state='started' ORDER BY at LIMIT 100").all()},null,2));
    } else {
      const id=value('--id'),digest=value('--digest');
      if(!args.includes('--confirm-offline')||!id||!digest)throw Error('请先停止 Go 和 Node，并提供记录 ID、摘要及 --confirm-offline');
      db.exec('BEGIN IMMEDIATE');
      try {
        const row=db.prepare("SELECT id,digest,at,payload FROM receipts WHERE id=? AND digest=? AND state='started'").get(id,digest);
        if(!row)throw Error('待核对记录或摘要不匹配');
        const directory=join(root,'reconciliation-backups');await mkdir(directory,{recursive:true,mode:0o700});
        const backup=join(directory,randomUUID()+'.json');const out=await open(backup,'wx',0o600);
        try{await out.writeFile(JSON.stringify({...row,payload:Buffer.from(row.payload).toString('base64'),action,atReconciled:new Date().toISOString()})+'\n');await out.sync();}finally{await out.close();}
        if(action==='mark-applied')db.prepare("UPDATE receipts SET state='done',payload=NULL WHERE id=?").run(id);
        else db.prepare('DELETE FROM receipts WHERE id=?').run(id);
        db.exec('COMMIT');console.log(JSON.stringify({id,action,backup,restartRequired:true,upstreamCalled:false}));
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
  }finally{db.close();}
}catch(error){console.error(error.message);process.exitCode=1;}
