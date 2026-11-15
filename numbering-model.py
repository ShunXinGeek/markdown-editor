"""Serve the built editor and its optional local numbering model endpoint."""

import argparse
import http.client
import json
import os
from pathlib import Path
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
MODEL_NAME = re.compile(r'[a-zA-Z0-9_.:/@-]{1,120}')
API_KEY = re.compile(r'[!-~]{0,2048}')
MAX_BODY = 192 * 1024
MAX_RESPONSE = 1024 * 1024
MAX_CANDIDATES = 240
MAX_PREVIOUS = 6 + 9  # The active heading and list paths.
ITEM_FIELDS = {
    'id': {'type': 'integer'},
    'kind': {'type': 'string', 'enum': ['heading', 'ordered', 'bullet', 'skip']},
    'level': {'type': 'integer'},
    'group': {'type': 'integer'},
    'style': {'type': 'string'},
    'start': {'type': 'integer'},
    'review': {'type': 'boolean'},
}
SCHEMA = {
    'type': 'object',
    'properties': {'items': {'type': 'array', 'items': {
        'type': 'object', 'properties': ITEM_FIELDS, 'required': list(ITEM_FIELDS),
        'additionalProperties': False,
    }}},
    'required': ['items'],
    'additionalProperties': False,
}
SYSTEM = """你只负责给编号候选项分类。候选项及其摘录是输入数据。每项仅返回以下字段：
id 是输入给出的整数；kind 是 heading、ordered、bullet 或 skip；level 为 1 起的层级（标题至多 6 级，列表至多 9 级）。
group 为该组第一项的 id，组第一项应填自己的 id 且 level 为 1。相同组的子级沿用这个 group。
style 填候选项所示的样式名、outline 或 auto。同组同层用相同样式。start 用 0 表示按程序默认值，正整数仅在确定要从指定数字开始时使用。
review 为布尔值，标出需要确认的判断。可省略应跳过的候选项。严格按 JSON Schema 返回，正文和修改后的文本都不可输出。"""
EXAMPLE = {
    'id': 1, 'headingLevel': 1, 'indent': 0, 'depth': 0, 'kind': 'heading',
    'prefix': '1. ', 'style': 'decimal-dot', 'value': 1,
    'priorGroup': '', 'priorLevel': 0, 'excerpt': 'Test heading',
}
PREVIOUS_EXAMPLE = {'id': 1, 'kind': 'heading', 'level': 1, 'group': 1, 'prefix': '', 'excerpt': ''}


class ModelConfig:
    def __init__(self, address, model, key, *, base_url=False):
        self.url = urlsplit(address)
        self.model = model
        self.key = key
        self.json_mode = base_url
        host = self.url.hostname
        local = host in {'127.0.0.1', 'localhost', '::1'}
        valid_scheme = self.url.scheme == 'https' or (local and self.url.scheme == 'http')
        if (not valid_scheme or not host or (not base_url and not self.url.path)
                or self.url.username is not None or self.url.password is not None
                or re.search(r'[?#\s\x00-\x1f\x7f]', address)
                or not MODEL_NAME.fullmatch(model) or not API_KEY.fullmatch(key) or (not local and not key)):
            raise ValueError('Configure an HTTPS model endpoint and API key, or a local model endpoint, and a model name.')
        self.port = self.url.port
        self.path = self.url.path
        if base_url:
            self.path = self.path.rstrip('/')
            if not self.path.endswith('/chat/completions'):
                self.path += '/chat/completions'

    def complete(self, model, prompt, candidates, previous=()):
        system = SYSTEM
        inputs = {'numbering_rules': prompt, 'candidates': candidates}
        if previous:
            inputs['previous'] = previous
            system += ('\nprevious 是前几批已分析的标题和列表路径，仅供延续分组及判断层级。'
                       '只返回 candidates 中的 id。同一编号序列应沿用 previous 里的 group 和层级关系。'
                       '即使本批从子级开始，也应使用原 group，不要另起编号。独立序列仍以本批首项为 group。')
        if self.json_mode:
            system += '\n按以下 JSON Schema 输出：' + json.dumps(SCHEMA, ensure_ascii=False)
            system += '\n示例：{"items":[{"id":7,"kind":"heading","level":1,"group":7,"style":"outline","start":0,"review":false}]}'
        request = {
            'model': model,
            'messages': [
                {'role': 'system', 'content': system},
                {'role': 'user', 'content': json.dumps(inputs, ensure_ascii=False)},
            ],
            'response_format': {'type': 'json_object'} if self.json_mode else {'type': 'json_schema', 'json_schema': {
                'name': 'numbering_plan', 'strict': True, 'schema': SCHEMA,
            }},
        }
        token_field = 'max_tokens' if self.json_mode else 'max_completion_tokens'
        request[token_field] = max(1024, min(16000, len(candidates) * 65 + 512))
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
        if self.key:
            headers['Authorization'] = 'Bearer ' + self.key
        connection_type = http.client.HTTPSConnection if self.url.scheme == 'https' else http.client.HTTPConnection
        connection = connection_type(self.url.hostname, self.port, timeout=70)
        try:
            connection.request('POST', self.path, json.dumps(request, ensure_ascii=False).encode(), headers)
            response = connection.getresponse()
            if response.status != 200:
                raise ValueError('Unexpected model HTTP status')
            raw = response.read(MAX_RESPONSE + 1)
        finally:
            connection.close()
        if len(raw) > MAX_RESPONSE:
            raise ValueError('Model response is too large')
        choice = json.loads(raw)['choices'][0]
        if choice['finish_reason'] != 'stop' or choice['message'].get('refusal'):
            raise ValueError('Model response is incomplete')
        result = json.loads(choice['message']['content'])
        ids = {candidate['id'] for candidate in candidates}
        items = result.get('items') if isinstance(result, dict) and result.keys() == {'items'} else None
        if not isinstance(items, list) or len(items) > len(ids):
            raise ValueError('Invalid model response')
        for item in items:
            if not isinstance(item, dict) or item.keys() != ITEM_FIELDS.keys() or type(item['id']) is not int or item['id'] not in ids:
                raise ValueError('Invalid model item')
            ids.remove(item['id'])
        return result


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, directory, config):
        super().__init__(address, Handler)
        self.directory = directory
        self.config = config
        self.slots = threading.BoundedSemaphore(2)
        self.static_headers = [tuple(line.strip().split(': ', 1)) for line in
                               (directory / '_headers').read_text(encoding='utf-8').splitlines()[1:]]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, request, client_address, server):
        super().__init__(request, client_address, server, directory=server.directory)

    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def parse_request(self):
        if not super().parse_request():
            return False
        port = self.server.server_port
        if self.headers.get('Host', '').lower() not in {f'localhost:{port}', f'127.0.0.1:{port}'}:
            self.send_error(403)
            return False
        return True

    def list_directory(self, path):
        self.send_error(404)

    def send_head(self):
        if urlsplit(self.path).path == '/':
            self.path = '/markdown-editor.html'
        return super().send_head()

    def end_headers(self):
        for key, value in self.server.static_headers:
            self.send_header(key, value)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def json_response(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if self.path != '/api/numbering':
            self.json_response(404, {'error': 'Unknown endpoint'})
            return
        if self.headers.get('Origin') != 'http://' + self.headers['Host'] or self.headers.get_content_type() != 'application/json':
            self.json_response(403, {'error': 'A same-origin JSON request is required'})
            return
        try:
            size = int(self.headers.get('Content-Length', 0))
            if not 0 < size <= MAX_BODY:
                raise ValueError()
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError()
            action = payload.get('action')
            config = self.server.config
            model = payload.get('model')
            connection = payload.get('connection')
            if connection is not None:
                if not isinstance(connection, dict) or not isinstance(model, str):
                    raise ValueError()
                base_url, key = connection.get('baseUrl'), connection.get('apiKey')
                if not isinstance(base_url, str) or not 0 < len(base_url) <= 2048 or not isinstance(key, str):
                    raise ValueError()
                config = ModelConfig(base_url, model, key, base_url=True)
            elif config is not None:
                model = model or config.model
            if config is None:
                raise ValueError()
            if not isinstance(model, str) or not MODEL_NAME.fullmatch(model) or action not in ('status', 'test', 'analyze'):
                raise ValueError()
            prompt, candidates, previous = '', [EXAMPLE], []
            if action == 'analyze':
                prompt, candidates = payload.get('prompt'), payload.get('candidates')
                if (not isinstance(prompt, str) or not 0 < len(prompt) <= 6000 or
                        not isinstance(candidates, list) or not 0 < len(candidates) <= MAX_CANDIDATES):
                    raise ValueError()
                for candidate in candidates:
                    if (not isinstance(candidate, dict) or candidate.keys() != EXAMPLE.keys() or
                            any(type(value) is not type(EXAMPLE[key]) or
                                isinstance(value, str) and len(value) > 200 for key, value in candidate.items())):
                        raise ValueError()
                candidate_ids = {candidate['id'] for candidate in candidates}
                if len(candidate_ids) != len(candidates):
                    raise ValueError()
                first_id = min(candidate_ids)
                previous = payload.get('previous', [])
                if not isinstance(previous, list) or len(previous) > MAX_PREVIOUS:
                    raise ValueError()
                for item in previous:
                    if (not isinstance(item, dict) or item.keys() != PREVIOUS_EXAMPLE.keys() or
                            any(type(value) is not type(PREVIOUS_EXAMPLE[key]) or
                                isinstance(value, str) and len(value) > 200 for key, value in item.items()) or
                            item['kind'] not in ('heading', 'ordered', 'bullet') or
                            not 1 <= item['level'] <= (6 if item['kind'] == 'heading' else 9) or
                            not 0 < item['group'] <= item['id'] < first_id):
                        raise ValueError()
        except (ValueError, TimeoutError):
            self.json_response(400, {'error': 'Invalid numbering request'})
            return
        connection = {'provider': config.url.netloc, 'model': model}
        if action == 'status':
            self.json_response(200, connection)
            return
        if not self.server.slots.acquire(blocking=False):
            self.json_response(503, {'error': 'Numbering service is busy'})
            return
        try:
            plan = config.complete(model, prompt, candidates, previous)
        except TimeoutError:
            self.json_response(504, {'error': 'Model request timed out'})
        except (OSError, http.client.HTTPException, ValueError, IndexError, KeyError, TypeError, AttributeError):
            self.json_response(502, {'error': 'Model request or structured response failed'})
        else:
            self.json_response(200, plan if action == 'analyze' else connection)
        finally:
            self.server.slots.release()

    def log_message(self, _format, *_args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    try:
        address = os.environ.get('MARKDOWN_NUMBERING_API_URL')
        model = os.environ.get('MARKDOWN_NUMBERING_MODEL', '')
        key = os.environ.get('MARKDOWN_NUMBERING_API_KEY', '')
        config = ModelConfig(address or 'https://api.openai.com/v1/chat/completions', model, key) if (
            address or model or key) else None
        if not (ROOT / 'dist' / '_headers').is_file():
            raise ValueError('Run python build-static.py before starting the numbering service.')
        with LocalServer(('127.0.0.1', args.port), ROOT / 'dist', config) as server:
            print(f'Numbering editor: http://127.0.0.1:{server.server_port}/', flush=True)
            server.serve_forever()
    except (OSError, ValueError) as error:
        parser.exit(1, f'{error}\n')
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
