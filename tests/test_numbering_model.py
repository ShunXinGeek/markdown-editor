import json
from pathlib import Path
import runpy
from tempfile import TemporaryDirectory
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen


module = runpy.run_path('numbering-model.py')


class NumberingServiceTest(unittest.TestCase):
    def setUp(self):
        self.upstream_requests = []
        self.invalid_response = False
        test = self

        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                test.upstream_requests.append((request, self.headers.get('Authorization')))
                inputs = json.loads(request['messages'][1]['content'])
                candidate = inputs['candidates'][0]
                item = {'id': candidate['id'], 'kind': 'ordered', 'level': 1, 'group': candidate['id'],
                        'style': 'outline', 'start': 0, 'review': False}
                if inputs.get('previous'):
                    item.update(group=inputs['previous'][0]['group'], level=candidate['headingLevel'])
                if test.invalid_response:
                    item['excerpt'] = 'unexpected replacement'
                data = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {
                    'content': json.dumps({'items': [item]})}}]}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, _format, *_args):
                pass

        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.start_server(upstream)
        self.upstream_base = f'http://127.0.0.1:{upstream.server_port}/v1'
        directory = Path(self.enterContext(TemporaryDirectory()))
        (directory / '_headers').write_text('/*\n  X-Content-Type-Options: nosniff\n', encoding='utf-8')
        (directory / 'markdown-editor.html').write_text('<title>Editor fixture</title>', encoding='utf-8')
        config = module['ModelConfig'](self.upstream_base + '/chat/completions', 'fixture-model', 'fixture-key')
        self.editor = module['LocalServer'](('127.0.0.1', 0), directory, config)
        self.start_server(self.editor)
        self.origin = f'http://127.0.0.1:{self.editor.server_port}'

    def start_server(self, server):
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

    def post(self, data, origin=None):
        request = Request(self.origin + '/api/numbering', json.dumps(data).encode(), headers={
            'Content-Type': 'application/json',
            'Origin': self.origin if origin is None else origin,
        })
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_serves_editor_and_calls_configured_structured_model(self):
        with urlopen(self.origin + '/', timeout=5) as response:
            self.assertIn(b'Editor fixture', response.read())
        self.assertEqual(self.post({'action': 'status'})[1]['model'], 'fixture-model')
        self.assertEqual(self.upstream_requests, [])
        self.assertEqual(self.post({'action': 'test'})[0], 200)
        candidate = {**module['EXAMPLE'], 'id': 5, 'excerpt': 'Document excerpt'}
        status, result = self.post({'action': 'analyze', 'prompt': 'Use outline', 'candidates': [candidate]})
        self.assertEqual((status, result['items'][0]['id']), (200, 5))
        payload, authorization = self.upstream_requests[-1]
        self.assertEqual(authorization, 'Bearer fixture-key')
        self.assertTrue(payload['response_format']['json_schema']['strict'])
        self.assertEqual(json.loads(payload['messages'][1]['content']), {
            'numbering_rules': 'Use outline', 'candidates': [candidate],
        })

    def test_rejects_cross_origin_and_unexpected_model_fields(self):
        self.assertEqual(self.post({'action': 'test'}, 'https://example.org')[0], 403)
        self.assertEqual(self.post({'action': 'analyze', 'prompt': 'rules', 'candidates': []})[0], 400)
        self.assertEqual(self.upstream_requests, [])
        self.invalid_response = True
        self.assertEqual(self.post({'action': 'test'})[0], 502)

    def test_later_batch_supplies_prior_groups_to_model(self):
        candidate = {**module['EXAMPLE'], 'id': 501, 'headingLevel': 2}
        previous = {**module['PREVIOUS_EXAMPLE'], 'id': 499, 'group': 1, 'excerpt': 'Earlier chapter'}
        request = {'action': 'analyze', 'prompt': 'x' * 6000, 'candidates': [candidate], 'previous': [previous]}
        status, response = self.post(request)
        self.assertEqual((status, response['items'][0]['group'], response['items'][0]['level']), (200, 1, 2))
        payload, _ = self.upstream_requests[-1]
        self.assertIn('previous', payload['messages'][0]['content'])
        self.assertEqual(json.loads(payload['messages'][1]['content']), {
            'numbering_rules': request['prompt'], 'candidates': [candidate], 'previous': [previous],
        })
        self.assertEqual(self.post({**request, 'previous': [{**previous, 'id': 501}]})[0], 400)
        self.assertEqual(self.post({**request, 'previous': [previous] * 16})[0], 400)
        self.assertEqual(len(self.upstream_requests), 1)

    def test_browser_settings_work_without_defaults_and_use_a_json_object(self):
        self.editor.config = None
        self.assertEqual(self.post({'action': 'status'})[0], 400)
        settings = {'model': 'browser-model', 'connection': {'baseUrl': self.upstream_base + '/', 'apiKey': 'browser-key'}}
        self.assertEqual(self.post({**settings, 'action': 'status'})[1]['model'], 'browser-model')
        self.assertEqual(self.upstream_requests, [])
        self.assertEqual(self.post({**settings, 'action': 'test'})[0], 200)
        payload, authorization = self.upstream_requests[-1]
        self.assertEqual(authorization, 'Bearer browser-key')
        self.assertEqual(payload['model'], 'browser-model')
        self.assertEqual(payload['response_format'], {'type': 'json_object'})
        self.assertIn('max_tokens', payload)
        self.assertIn('JSON Schema', payload['messages'][0]['content'])
        bad_connection = {**settings['connection'], 'baseUrl': 'http://example.org/v1'}
        self.assertEqual(self.post({**settings, 'action': 'test', 'connection': bad_connection})[0], 400)
        self.assertEqual(len(self.upstream_requests), 1)
