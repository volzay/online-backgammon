"""Private operator: retrieve connector-issued ZIP links and verify provenance.

The manifest contains ephemeral download links, never an API token or journal key.
ZIP digests and exact run/commit bindings come from the GitHub connector.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile

BASE = Path('/var/lib/online-backgammon-expanded-study-20261123')
OPERATOR = Path(__file__).parent


def collect(item):
    artifact_id = item['artifactId']
    fragment = item['fragment']
    commit = item['commit']
    if not isinstance(artifact_id, int) or not re.fullmatch(r'[A-Z0-9]{4}-[A-Z0-9]{4}-[dt]\d+-s\d+', fragment):
        raise ValueError('Invalid fixed artifact identity')
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or not re.fullmatch(r'sha256:[0-9a-f]{64}', item['digest']):
        raise ValueError('Exact commit and ZIP digest required')
    parsed = urllib.parse.urlparse(item['url'])
    if parsed.scheme != 'https' or not parsed.hostname.endswith('.oaiusercontent.com'):
        raise ValueError('Connector-issued file link required')
    incoming = BASE / 'incoming' / str(artifact_id)
    incoming.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive = incoming / 'artifact.zip'
    if not archive.exists():
        with urllib.request.urlopen(item['url'], timeout=60) as response:
            data = response.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024:
            raise ValueError('Unexpected artifact size')
        if 'sha256:' + hashlib.sha256(data).hexdigest() != item['digest']:
            raise ValueError('ZIP digest mismatch')
        archive.write_bytes(data)
        archive.chmod(0o600)
    if 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest() != item['digest']:
        raise ValueError('Saved ZIP digest mismatch')
    sealed = fragment + '.sealed.json'
    with zipfile.ZipFile(archive) as z:
        if set(z.namelist()) != {sealed, 'attestation.sigstore.json'} or sum(x.file_size for x in z.infolist()) > 32 * 1024 * 1024:
            raise ValueError('Unexpected ZIP contents')
        z.extractall(incoming)
    process = subprocess.run(['node', str(OPERATOR / 'verify-and-decrypt.cjs'), str(incoming / sealed),
                              str(incoming / 'attestation.sigstore.json'), commit, str(BASE / 'verified')],
                             capture_output=True, text=True, timeout=120)
    if process.returncode:
        # Do not expose untrusted network URLs or ciphertext in operator output.
        raise RuntimeError('Native signature/fragment verification failed for ' + fragment + ': ' + process.stderr[-1200:])
    receipt = json.loads(process.stdout)
    (incoming / 'verified-receipt.json').write_text(json.dumps({**receipt, 'artifactId': artifact_id, 'zipDigest': item['digest']}) + '\n')
    return receipt


if __name__ == '__main__':
    if sys.platform != 'linux' or os.getuid() != 0:
        raise RuntimeError('Private Linux operator required')
    os.umask(0o077)
    manifest = Path(sys.argv[1])
    items = json.loads(manifest.read_text())
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        for result in executor.map(collect, items):
            print(json.dumps(result), flush=True)
    manifest.unlink()  # Expiring links are not part of scientific provenance.
