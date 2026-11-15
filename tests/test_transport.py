import gzip, http.server, runpy, socket, threading, unittest
from unittest.mock import patch

proxy = runpy.run_path('web-to-md-proxy.py')
namespace = proxy['fetch_url'].__globals__

class Upstream(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/start':
            self.send_response(302)
            self.send_header('Location', '/gzip')
            self.end_headers()
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Encoding', 'gzip')
            self.end_headers()
            self.wfile.write(gzip.compress(b'<p>fixture</p>'))
    def log_message(self,*args): pass

class TransportTest(unittest.TestCase):
    def test_redirect_gzip_and_limit(self):
        with http.server.ThreadingHTTPServer(('127.0.0.1',0), Upstream) as upstream:
            thread=threading.Thread(target=upstream.serve_forever,daemon=True)
            thread.start()
            try:
                from urllib.parse import urlsplit
                visited=[]
                def validated(url, _deadline):
                    visited.append(url)
                    return urlsplit(url),'127.0.0.1',upstream.server_port,'127.0.0.1'
                with patch.dict(namespace,validate_target=validated):
                    html,url=proxy['fetch_url']('http://fixture.example/start')
                    self.assertEqual(html,'<p>fixture</p>')
                    self.assertEqual(visited,['http://fixture.example/start','http://fixture.example/gzip'])
                    self.assertEqual(url,visited[-1])
                    with patch.dict(namespace, MAX_BYTES=8):
                        with self.assertRaises(proxy['FetchError']) as error: proxy['fetch_url'](url)
                        self.assertEqual(error.exception.status,413)
            finally:
                upstream.shutdown()




