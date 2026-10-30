#!/usr/bin/env python3
"""Resolve checkout source or render a manifest to stdout; never edit tracked files."""
import argparse
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True, stderr=subprocess.DEVNULL).strip()

def resolve(url=None):
    url = url or os.environ.get('SOURCE_REPO_URL')
    revision = os.environ.get('SOURCE_REPO_REVISION')
    if not url or not revision:
        try:
            if Path(git('rev-parse', '--show-toplevel')).resolve() != ROOT:
                raise ValueError('not a Git checkout')
            url = url or git('remote', 'get-url', 'origin')
            revision = revision or git('rev-parse', 'HEAD')
        except (subprocess.CalledProcessError, ValueError):
            raise ValueError('Use a Git checkout with origin, or set SOURCE_REPO_URL and SOURCE_REPO_REVISION')
    match = re.fullmatch(r'git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+)', url)
    if match:
        url = f'https://{match[1]}/{match[2]}'
    parsed = urlsplit(url)
    if not re.fullmatch(r'https://[A-Za-z0-9._~:/%+-]+', url) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Use an HTTPS repository URL without credentials, query or fragment')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/+-]*', revision):
        raise ValueError('Invalid source revision')
    return url, revision

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url', nargs='?')
    parser.add_argument('--revision', action='store_true', help='Print resolved revision instead of URL')
    parser.add_argument('--render', type=Path, help='Render this manifest to stdout')
    args = parser.parse_args()
    try:
        url, revision = resolve(args.url)
    except ValueError as error:
        parser.error(str(error))
    if args.render:
        content = args.render.read_text().replace('__SOURCE_REPO_URL__', url).replace('__SOURCE_REPO_REVISION__', revision)
        print(content, end='')
    else:
        print(revision if args.revision else url)

if __name__ == '__main__':
    main()
