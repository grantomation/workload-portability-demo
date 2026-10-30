"""Exercise platform decisions with stub commands; no network or system writes."""
from pathlib import Path
import json, os, subprocess, tempfile
ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
    directory = Path(tmp)
    for name, body in {
        'virt-what': 'printf "%s\\n" "$TEST_HYPERVISOR"; exit "${TEST_VIRT_EXIT:-0}"',
        'curl': 'echo called >> "$TEST_CURL_LOG"; printf "%s" "$TEST_METADATA"',
        'sleep': 'exit 0',
    }.items():
        p = directory / name
        p.write_text('#!/bin/sh\n'+body+'\n')
        p.chmod(0o755)
    cases = [
        ('other-platform', '0', '', 'Legacy Infra', False),
        ('', '1', '', 'Legacy Infra', False),
        ('', '127', '', 'Legacy Infra', False),
        ('kvm', '0', '{"issuer":"https://login.aroapp.io"}', 'Azure Red Hat OpenShift', True),
        ('other\nkvm', '0', '{"issuer":"https://cluster.example.com"}', 'OpenShift Virtualization', True),
        ('kvm', '0', '', 'Unknown', True),
    ]
    for hypervisor, code, metadata, platform, calls_metadata in cases:
        log = directory / 'curl.log'
        log.unlink(missing_ok=True)
        output = directory / 'infra.json'
        env = dict(os.environ, PATH=str(directory)+os.pathsep+os.environ['PATH'],
                   TEST_HYPERVISOR=hypervisor, TEST_VIRT_EXIT=code, TEST_METADATA=metadata,
                   TEST_CURL_LOG=str(log), INFRA_OUTPUT_FILE=str(output))
        subprocess.run(['sh', str(ROOT/'02_workload/portable-infra-detect.sh')], env=env,
                       check=True, capture_output=True, timeout=10)
        assert json.loads(output.read_text())['platform'] == platform
        assert log.exists() == calls_metadata
print('PASS: KVM, multiline detection, generic fallback, failed/missing detection and metadata timeout')
