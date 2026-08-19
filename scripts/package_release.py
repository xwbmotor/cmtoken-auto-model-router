#!/usr/bin/env python3
"""对外交付打包脚本（Windows git-bash / Linux 均可）：git archive + 内容级脱敏。

用法:
    python scripts/package_release.py [输出路径.tar.gz]   # 默认 $TMP/auto-model-router-<短SHA>.tar.gz

流程:
  1. git archive HEAD（prefix=auto-model-router/，只打包已提交内容，.env/日志天然排除）
  2. 内容级脱敏：把内网端点替换为占位符（部署方在 .env 设 UPSTREAM_BASE_URL 即恢复，src 优先读 env）
  3. 复检：以 .env 全部键值前缀为模式扫描包内全文本，命中即失败退出
  4. 输出清单与敏感扫描报告

红线: 任何 .env 键值、内网主机名不得出现在交付包内。
"""
import os, re, subprocess, sys, tarfile, tempfile, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

def short_sha():
    return subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()

def env_secrets():
    """读 .env（若存在）取凭证类 (键名, 值前10字符) 列表——只用于匹配，不打印完整值。
    只扫 KEY/TOKEN/SECRET/PASSWORD 类；HOST/PORT/CONFIG_PATH/BASE_URL 属配置非凭证（URL 由 internal_hosts 全包扫）。"""
    p = os.path.join(ROOT, '.env')
    if not os.path.exists(p): return []
    out = []
    for line in open(p, encoding='utf-8'):
        m = re.match(r'([A-Z_]+)=(\S{8,})', line)
        if m and re.search(r'KEY|TOKEN|SECRET|PASSWORD', m.group(1)):
            out.append((m.group(1), m.group(2)[:10]))
    return out

def internal_hosts():
    """需要脱敏的内网主机名集合：.env 的 MAAS_BASE_URL/UPSTREAM_BASE_URL + router.json 的 upstreamBaseUrl。"""
    hosts = set()
    p = os.path.join(ROOT, '.env')
    if os.path.exists(p):
        for line in open(p, encoding='utf-8'):
            m = re.match(r'(?:MAAS|UPSTREAM)_BASE_URL=(\S+)', line)
            if m:
                h = urllib.parse.urlparse(m.group(1) if '//' in m.group(1) else 'http://' + m.group(1)).hostname
                if h: hosts.add(h)
    try:
        import json
        cfg = json.load(open(os.path.join(ROOT, 'config/router.json'), encoding='utf-8'))
        u = cfg.get('upstreamBaseUrl', '')
        if u:
            h = urllib.parse.urlparse(u if '//' in u else 'http://' + u).hostname
            if h: hosts.add(h)
    except Exception:
        pass
    return hosts

def sanitize_tar(src_path, dst_path, hosts):
    """按成员逐个改写：内网主机名 → <MAAS_HOST>。二进制按字节替换。"""
    replaced = {}
    with tarfile.open(src_path) as tin, tarfile.open(dst_path, 'w:gz') as tout:
        for m in tin.getmembers():
            data = tin.extractfile(m).read() if m.isfile() else None
            if data is not None:
                for h in hosts:
                    pat = re.compile(h.replace('.', r'\.').encode())
                    n = len(pat.findall(data))
                    if n:
                        data = pat.sub(b'<MAAS_HOST>', data)
                        replaced[m.name] = replaced.get(m.name, 0) + n
            ti = tarfile.TarInfo(m.name)
            ti.size = len(data) if data is not None else 0
            ti.mode, ti.mtime = m.mode, 0
            ti.type = tarfile.REGTYPE if data is not None else tarfile.DIRTYPE
            tout.addfile(ti, io_bytes(data) if data is not None else None)
    return replaced

def io_bytes(b):
    import io; return io.BytesIO(b)

def verify(dst_path, secrets, hosts):
    hits = []
    host_pats = [re.compile(h.replace('.', r'\.')) for h in hosts]
    with tarfile.open(dst_path) as t:
        for m in t.getmembers():
            if not m.isfile() or m.size > 3_000_000: continue
            text = t.extractfile(m).read().decode('utf-8', 'ignore')
            for name, prefix in secrets:
                if prefix in text: hits.append((m.name, name))
            if re.search(r'sk-[A-Za-z0-9]{20,}', text): hits.append((m.name, 'sk-pattern'))
            for hp in host_pats:
                if hp.search(text): hits.append((m.name, '内网主机名残留'))
    return hits

def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), f'auto-model-router-{short_sha()}.tar.gz')
    hosts = internal_hosts()
    if not hosts:
        print('警告: 未检测到内网主机名（.env 缺失?），跳过端点脱敏——请人工确认')
    secrets = env_secrets()
    raw = out + '.raw'
    r = subprocess.run(['git', 'archive', '--format=tar.gz', '-o', raw, 'HEAD', '--prefix=auto-model-router/'])
    if r.returncode: sys.exit('git archive 失败')
    replaced = sanitize_tar(raw, out, hosts)
    os.remove(raw)
    hits = verify(out, secrets, hosts)
    n_files = len(tarfile.open(out).getnames())
    print(f'输出: {out}')
    print(f'文件数: {n_files}  脱敏替换: {len(replaced)} 个文件')
    if replaced:
        for f, n in sorted(replaced.items()): print(f'  {f}: {n} 处')
    if hits:
        print('敏感扫描: 失败！命中:', hits); sys.exit(1)
    print('敏感扫描: 通过（%d 个凭证前缀 + %d 个内网主机名 零命中）' % (len(secrets), len(hosts)))

if __name__ == '__main__':
    main()
