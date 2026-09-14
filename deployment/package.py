#!/usr/bin/env python3
"""Package verified release archives and an allowlisted fresh-install toolkit."""
import argparse
import json
from pathlib import Path
import shutil
import sys
import zipfile
from install import manifest, sha

REPO = Path(__file__).resolve().parents[1]


def package(source, output):
    release = manifest(REPO / 'deployment/release.json')
    if output.exists(): raise ValueError('Output must not exist')
    if sha(source) != release['sourceArchiveSha256']: raise ValueError('Release archive hash mismatch')
    output.mkdir(parents=True)
    with zipfile.ZipFile(source) as archive:
        (output/'images').mkdir()
        for item in release['images'].values():
            target=output/'images'/item['archive']
            with archive.open(item['archive']) as src, target.open('wb') as dst: shutil.copyfileobj(src,dst)
            if sha(target)!=item['sha256']: raise ValueError('Image archive hash mismatch')
    for name in ['install.py','verify.py','release.json','router.example.json','README.md']:
        shutil.copyfile(REPO/'deployment'/name,output/name)
    shutil.copyfile(REPO/'go-core/deployment/native_compose.py',output/'native_compose.py')
    (output/'SHA256SUMS').write_text(''.join(sha(p)+'  '+p.relative_to(output).as_posix()+'\n' for p in sorted(output.rglob('*')) if p.is_file()),encoding='utf-8')
    zipped=output.with_suffix('.zip')
    if zipped.exists():raise ValueError('Zip target must not exist')
    with zipfile.ZipFile(zipped,'x',compression=zipfile.ZIP_STORED) as archive:
        for p in sorted(output.rglob('*')):
            if p.is_file():archive.write(p,output.name+'/'+p.relative_to(output).as_posix())
    zipped.with_suffix('.zip.sha256').write_text(sha(zipped)+'  '+zipped.name+'\n',encoding='utf-8')
    print(json.dumps({'bundle':str(zipped),'sha256':sha(zipped),'applicationVersion':release['version']}))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--images',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();package(a.images,a.out)
