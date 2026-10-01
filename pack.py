import os
import zipfile
import json
import re
import tempfile

def pack_mod():
    src_dir = 'src'
    with open('src/boot.json', 'r', encoding='utf-8') as bf:
        boot = json.load(bf)
    version = boot['version']
    if not isinstance(version, str) or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise SystemExit('版本号必须为三段非负整数，如 1.0.4')
    version_key = tuple(map(int, version.split('.')))
    zip_name = f'ModHub-v{version}.zip'

    release_dir = os.path.abspath('release')
    os.makedirs(release_dir, exist_ok=True)

    release_target = os.path.join(release_dir, zip_name)
    packages = {}
    latest_version = version_key
    for name in os.listdir(release_dir):
        match = re.fullmatch(r'ModHub-v([0-9]+\.[0-9]+\.[0-9]+)(-archive[0-9]+)?\.zip', name)
        if match and os.path.isfile(os.path.join(release_dir, name)):
            parsed_version = tuple(map(int, match[1].split('.')))
            latest_version = max(latest_version, parsed_version)
            if not match[2]:
                packages[name] = parsed_version
    if version_key < latest_version:
        raise SystemExit('当前源码版本低于本地最新版本，拒绝覆盖或重新生成历史版本')

    def should_exclude(rel_path):
        parts = rel_path.split('/')
        if any(p.startswith('.') for p in parts):
            return True
        if 'copy' in rel_path.lower():
            return True
        if rel_path == 'test-smart-sort.js':
            return True
        return False

    fd, temporary_target = tempfile.mkstemp(prefix=f'.{zip_name}.', suffix='.tmp', dir=release_dir)
    os.close(fd)
    try:
        # 1. 临时包也放在 release 内，完整校验后才替换正式包。
        expected_files = set()
        with zipfile.ZipFile(temporary_target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for root, dirs, files in os.walk(src_dir):
                for f in files:
                    full_path = os.path.join(root, f)
                    rel_path = os.path.relpath(full_path, src_dir).replace('\\', '/')
                    if should_exclude(rel_path):
                        continue
                    expected_files.add(rel_path)
                    if rel_path.endswith('.twee'):
                        with open(full_path, 'r', encoding='utf-8') as tf:
                            twee_content = tf.read().replace('\r\n', '\n')
                        zf.writestr(rel_path, twee_content.encode('utf-8'))
                    else:
                        zf.write(full_path, arcname=rel_path)

        # 2. 校验包体完整性
        with zipfile.ZipFile(temporary_target, 'r') as zf:
            namelist = set(zf.namelist())
            if zf.testzip() is not None or 'boot.json' not in namelist:
                raise SystemExit('校验失败：压缩包损坏或根目录缺少 boot.json')
            if namelist != expected_files or len(namelist) != len(zf.namelist()):
                raise SystemExit('校验失败：包内清单与源码清单不一致，或存在重复条目')
            if any('\\' in name or name.startswith('/') or '..' in name.split('/') for name in namelist):
                raise SystemExit('校验失败：包内路径必须为安全的正斜杠相对路径')
            if json.loads(zf.read('boot.json'))['version'] != version:
                raise SystemExit('校验失败：包内版本与源码版本不一致')
            missing = []
            for k in ['styleFileList', 'scriptFileList_inject_early', 'scriptFileList', 'tweeFileList', 'imgFileList']:
                for path in boot.get(k, []):
                    if path not in namelist:
                        missing.append((k, path))

            for addon in boot.get('addonPlugin', []):
                params = addon.get('params', [])
                if isinstance(params, list):
                    for p in params:
                        rf = p.get('replaceFile')
                        if rf and rf not in namelist:
                            missing.append(('replaceFile', rf))

            if missing:
                print('校验失败：压缩包缺少声明文件：', missing)
                raise SystemExit(1)
            print('校验通过：包内版本、清单、文件完整性与正斜杠路径均正确')

        os.replace(temporary_target, release_target)
    finally:
        if os.path.exists(temporary_target):
            os.remove(temporary_target)

    print(f'打包完成：{release_target}（{os.path.getsize(release_target)} 字节）')

    # 3. 本地仅保留最新三个正式版本；同版本归档在正式包存在时移除。
    packages[zip_name] = version_key
    keep = set(sorted(packages, key=packages.get, reverse=True)[:3])
    for name in os.listdir(release_dir):
        archive = re.fullmatch(r'ModHub-v([0-9]+\.[0-9]+\.[0-9]+)-archive[0-9]+\.zip', name)
        duplicate = archive and f'ModHub-v{archive[1]}.zip' in packages
        target = os.path.join(release_dir, name)
        if os.path.isfile(target) and ((name in packages and name not in keep) or duplicate):
            os.remove(target)
            print(f'已移除本地旧包：{name}')
    for name in sorted(keep, key=packages.get, reverse=True):
        print(f'保留本地版本：{name}')

    # 4. 清理项目根目录下散落的任何 zip 包体，确保"只保留在 release 文件夹"
    for name in os.listdir('.'):
        if name.startswith('ModHub-v') and name.endswith('.zip'):
            try:
                os.remove(name)
                print(f'已清理根目录散落包体：{name}')
            except Exception as e:
                print(f'清理 {name} 时出现警告：{e}')

if __name__ == '__main__':
    pack_mod()
