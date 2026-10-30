"""Exercise the real packaging script with synthetic archive layouts (PyYAML)."""
from pathlib import Path
import io, json, os, subprocess, tarfile, tempfile
import yaml
ROOT = Path(__file__).resolve().parents[1]
docs = list(yaml.safe_load_all((ROOT/'01_installation_dashboard/pipelines/tekton/tasks.yml').read_text()))
task = next(d for d in docs if isinstance(d, dict) and d.get('metadata', {}).get('name') == 'build-migration-components-image')
script = task['spec']['steps'][0]['script']
packaging = script[script.index('# 2. Preserve'):script.index('# 4. Build')]
layouts = [
    {'component bundle/lib/module.so': b'library', 'component bundle/.metadata': b'hidden'},
    {'lib/module.so': b'library', 'bin/helper': b'executable', 'LICENSE': b'license'},
    {'module.so': b'flat archive', '.metadata': b'hidden'},
    {'Containerfile': b'archive build recipe must not replace generated recipe'},
    {},
]
for files in layouts:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        archive = root/'components.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name, content in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                entry.mode = 0o755 if name == 'bin/helper' else 0o644
                tar.addfile(entry, io.BytesIO(content))
        env = dict(os.environ, TMPDIR=tmp, TARBALL=str(archive))
        result = subprocess.run(['bash', '-c', 'set -euo pipefail\n'+packaging+'\nprintf "%s" "$BUILD_DIR"'],
                                env=env, capture_output=True, text=True)
        if not files:
            assert result.returncode != 0 and 'empty' in result.stdout
            continue
        assert result.returncode == 0, result.stderr
        build = Path(result.stdout.splitlines()[-1])
        recipe = (build/'Containerfile').read_text()
        assert 'COPY payload/ /migration-components/' in recipe
        command = json.loads(next(line[len('ENTRYPOINT '):] for line in recipe.splitlines() if line.startswith('ENTRYPOINT ')))
        destination = root/'runtime-opt'
        destination.mkdir()
        command[2] = str(build/'payload')+'/.'
        command[3] = str(destination)+'/'
        subprocess.run(command, check=True)
        for name, content in files.items():
            assert (destination/name).read_bytes() == content
        if 'bin/helper' in files:
            assert (destination/'bin/helper').stat().st_mode & 0o111
print('PASS: varying directory names, multiple roots, flat layouts, hidden files, permissions, recipe isolation and empty-archive rejection')
