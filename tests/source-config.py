"""Run without clusters: exercise both setup paths with a recording oc stub."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp) / 'checkout'
    shutil.copytree(ROOT, repo, ignore=shutil.ignore_patterns('.git', 'node_modules', '__pycache__'))
    def run(*args, **kwargs):
        return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)
    run('git', 'init', '-q', str(repo))
    run('git', '-C', str(repo), 'add', '.')
    run('git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
    run('git', '-C', str(repo), 'remote', 'add', 'origin', 'git@github.com:example-org/demo.git')
    revision = run('git', '-C', str(repo), 'rev-parse', 'HEAD').stdout.strip()
    before = run('git', '-C', str(repo), 'status', '--porcelain').stdout
    bin_dir = Path(tmp) / 'bin'
    bin_dir.mkdir()
    stub = bin_dir / 'oc'
    stub.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$OC_LOG"
if [ "$1" = apply ] && [ "$3" = - ]; then cat >> "$MANIFEST_LOG"; printf '\\n---\\n' >> "$MANIFEST_LOG"; fi
if [ "$1" = get ] && [ "$2" = csv ]; then echo openshift-pipelines-operator Succeeded; fi
if [ "$1" = get ] && [ "$2" = secret ]; then exit 1; fi
exit 0
''')
    stub.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith('SOURCE_REPO_')}
    env.update(PATH=str(bin_dir)+os.pathsep+env['PATH'], OC_LOG=str(Path(tmp)/'oc.log'), MANIFEST_LOG=str(Path(tmp)/'manifests'))
    for setup in ['01_installation_dashboard/setup.sh', '01_installation_dashboard/pipelines/setup.sh']:
        run('bash', str(repo/setup), env=env)
    manifests = Path(env['MANIFEST_LOG']).read_text()
    assert '__SOURCE_REPO_' not in manifests
    assert 'https://github.com/example-org/demo.git' in manifests
    assert revision in manifests
    assert 'name: SOURCE_REPO_URL' in manifests and 'name: SOURCE_REPO_REVISION' in manifests
    assert before == run('git', '-C', str(repo), 'status', '--porcelain').stdout
    helper = str(repo/'scripts/configure-source.py')
    assert run('python3', helper, env=env).stdout.strip() == 'https://github.com/example-org/demo.git'
    bad = subprocess.run(['python3', helper, 'https://user:secret@example.com/repo.git'], env=env, capture_output=True)
    assert bad.returncode != 0
    override = dict(env, SOURCE_REPO_URL='https://example.com/team/demo.git', SOURCE_REPO_REVISION='release/test')
    assert run('python3', helper, env=override).stdout.strip() == override['SOURCE_REPO_URL']
    assert run('python3', helper, '--revision', env=override).stdout.strip() == 'release/test'
print('PASS: both setup flows render source, dashboard env, origin discovery, overrides, credential rejection; checkout unchanged')
