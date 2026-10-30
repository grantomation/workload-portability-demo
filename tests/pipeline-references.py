"""Check pipeline references, including runs nested inside trigger templates.
Requires PyYAML.
"""
from pathlib import Path
import yaml

root = Path(__file__).resolve().parents[1] / '01_installation_dashboard/pipelines/tekton'
documents = [(p, d) for p in root.glob('*.yml') for d in yaml.safe_load_all(p.read_text()) if isinstance(d, dict)]
pipelines = {d['metadata']['name'] for _, d in documents if d.get('kind') == 'Pipeline'}

def check(value, filename):
    if isinstance(value, dict):
        ref = value.get('pipelineRef', {}).get('name')
        if ref:
            assert ref in pipelines, f'{filename}: missing pipeline {ref}'
        for child in value.values():
            check(child, filename)
    elif isinstance(value, list):
        for child in value:
            check(child, filename)

for filename, document in documents:
    check(document, filename.name)
print('PASS: all pipeline references resolve, including nested trigger runs')
