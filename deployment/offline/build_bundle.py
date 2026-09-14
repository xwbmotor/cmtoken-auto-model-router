"""Build the customer-specific offline archive on the packaging machine only."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import zipfile
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from install import manifest, sha
REPO=Path(__file__).resolve().parents[2]


def build(images, config, provenance, out):
    release=manifest(REPO/'deployment/release.json')
    if out.exists() or out.with_name(out.name+'.tar.gz').exists():raise ValueError('Output already exists')
    if sha(images)!=release['sourceArchiveSha256']:raise ValueError('Formal image archive differs')
    cfg=json.loads(config.read_text(encoding='utf-8-sig'))
    proof=json.loads(provenance.read_text(encoding='utf-8-sig'))
    if sha(config)!=proof['sha256'] or proof.get('source')!='running-admin-api' or proof.get('goSynchronized') is not True:
        raise ValueError('Effective configuration proof required')
    def check(v):
        import re
        if isinstance(v,dict):
            for k,x in v.items():
                if re.fullmatch(r'api_?key|token|secret|password|adminToken|accessKey|authorization',k,re.I) and x:raise ValueError('Credential in configuration')
                check(x)
        elif isinstance(v,list):
            for x in v:check(x)
    check(cfg)
    out.mkdir(parents=True);(out/'images').mkdir()
    with zipfile.ZipFile(images) as z:
        for item in release['images'].values():
            target=out/'images'/item['archive']
            with z.open(item['archive']) as src,target.open('wb') as dst:shutil.copyfileobj(src,dst)
            if sha(target)!=item['sha256']:raise ValueError('Image checksum mismatch')
    for name in ['install.sh','worker.mjs','compose.template.json','README.md']:
        # Linux scripts must retain LF even when packaged from a Windows checkout.
        text=(REPO/'deployment/offline'/name).read_text(encoding='utf-8-sig')
        (out/name).write_bytes(text.encode('utf-8'))
    shutil.copyfile(REPO/'deployment/release.json',out/'release.json')
    shutil.copyfile(config,out/'router.json');shutil.copyfile(provenance,out/'config-provenance.json')
    files=sorted(p for p in out.rglob('*') if p.is_file())
    (out/'SHA256SUMS').write_text(''.join(sha(p)+'  '+p.relative_to(out).as_posix()+'\n' for p in files),encoding='utf-8')
    archive=out.with_name(out.name+'.tar.gz')
    with tarfile.open(archive,'w:gz',compresslevel=1) as t:
        for p in files+[out/'SHA256SUMS']:
            info=t.gettarinfo(str(p),arcname=out.name+'/'+p.relative_to(out).as_posix())
            info.uid=info.gid=0;info.uname=info.gname='';info.mode=0o755 if p.name=='install.sh' else 0o644
            with p.open('rb') as f:t.addfile(info,f)
    checksum=sha(archive)
    archive.with_name(archive.name+'.sha256').write_text(checksum+'  '+archive.name+'\n',encoding='utf-8')
    print(json.dumps({'file':str(archive),'bytes':archive.stat().st_size,'sha256':checksum,'models':len(cfg['models']),'hostPythonRequired':False}))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['images','config','provenance','out']:p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args();build(a.images,a.config,a.provenance,a.out)
