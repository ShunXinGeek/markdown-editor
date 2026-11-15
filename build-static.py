"""Assemble the exact static site files and verify vendored assets."""
import argparse
import base64
import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path
import shutil
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
FILES = ('markdown-editor.html', 'i18n.js', 'draft-storage.js', 'render-content.js', 'editor-list-format.js', 'editor-attachments.js', 'editor-workspace.js', 'LICENSE')


def digest(data, algorithm='sha384'):
    return algorithm + '-' + base64.b64encode(hashlib.new(algorithm, data).digest()).decode()


class ScriptPolicy(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = set()
        self.handlers = set()
        self.source = None

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and 'src' not in dict(attrs):
            self.source = ''
        for attr, value in attrs:
            if attr.startswith('on') and value:
                self.handlers.add(digest(value.encode(), 'sha256'))

    def handle_data(self, data):
        if self.source is not None:
            self.source += data

    def handle_endtag(self, tag):
        if tag == 'script' and self.source is not None:
            self.scripts.add(digest(self.source.encode(), 'sha256'))
            self.source = None

    def headers(self):
        scripts = ' '.join(f"'{value}'" for value in sorted(self.scripts))
        handlers = ' '.join(f"'{value}'" for value in sorted(self.handlers))
        return (
            "/*\n"
            "  X-Content-Type-Options: nosniff\n"
            "  Referrer-Policy: no-referrer\n"
            "  Content-Security-Policy: default-src 'none'; "
            f"script-src 'self' https://cdn.jsdelivr.net {scripts}; "
            f"script-src-attr 'unsafe-hashes' {handlers}; "
            "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
            "font-src 'self' data: https://cdn.jsdelivr.net; "
            "img-src 'self' data: blob: https: http:; "
            "connect-src 'self' data: blob: https: http:; "
            "base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'\n"
        )


def build(output):
    output = output.resolve()
    sources = [ROOT / name for name in FILES]
    offline_sources = []
    manifest = ROOT / 'vendor' / 'dependencies.json'
    html = sources[0].read_text(encoding='utf-8')
    assets = json.loads(manifest.read_text(encoding='utf-8'))
    for name, asset in assets.items():
        if '.' in name and name != 'katex.css':
            file = manifest.parent / name
            if digest(file.read_bytes()) != asset['integrity']:
                raise ValueError(f'Integrity check failed: {name}')
            (offline_sources if name.startswith('offline/') else sources).append(file)
        elif asset['url'] not in html or asset['integrity'] not in html:
            raise ValueError(f'Optional dependency manifest mismatch: {name}')

    policy = ScriptPolicy()
    policy.feed(html)
    output.mkdir(exist_ok=True, parents=True)
    sources.append(manifest)
    expected = {file.relative_to(ROOT) for file in sources} | {Path('_headers'), Path('markdown-editor-offline.zip')}
    unexpected = {file.relative_to(output) for file in output.rglob('*') if file.is_file()} - expected
    if unexpected:
        raise ValueError(f'Unexpected files in publish directory: {sorted(map(str, unexpected))}')
    for source in sources:
        destination = output / source.relative_to(ROOT)
        destination.parent.mkdir(exist_ok=True)
        shutil.copyfile(source, destination)
    (output / '_headers').write_text(policy.headers(), encoding='utf-8')
    with tempfile.TemporaryFile() as packaged:
        with zipfile.ZipFile(packaged, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            offline_html = html
            for asset in assets.values():
                if 'offline' not in asset:
                    continue
                relative = 'vendor/' + asset['offline']
                asset_file = ROOT / relative
                if digest(asset_file.read_bytes()) != asset['integrity']:
                    raise ValueError(f'Integrity check failed: {relative}')
                archive.write(asset_file, relative)
                offline_html = offline_html.replace(asset['url'], relative)
            for source in sources + offline_sources:
                relative = source.relative_to(ROOT).as_posix()
                if relative == 'markdown-editor.html':
                    archive.writestr(relative, offline_html)
                else:
                    archive.write(source, relative)
            archive.writestr('README.txt',
                'Open markdown-editor.html for offline editing, preview, math and diagrams.\n'
                'For durable attachment storage use: python -m http.server 8080\n'
                'Open http://localhost:8080/markdown-editor.html in a browser.\n')
        packaged.seek(0)
        with (output / 'markdown-editor-offline.zip').open('wb') as destination:
            shutil.copyfileobj(packaged, destination)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    build(parser.parse_args().output)
    print('Static site assembled and vendored files verified.')


