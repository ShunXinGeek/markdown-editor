import gzip, http.server, json, runpy, socket, threading, time, unittest
import urllib.error, urllib.parse, urllib.request
from unittest.mock import patch

p=runpy.run_path('web-to-md-proxy.py')
globals_=p['Handler'].do_GET.__globals__
origin='http://127.0.0.1:8080'
headers={'Origin':origin,'X-Markdown-Token':'test-token'}
class ServerTest(unittest.TestCase):
    def setUp(self):
        self.proxy=p['ProxyServer'](('127.0.0.1',0),'test-token',{origin})
        threading.Thread(target=self.proxy.serve_forever,daemon=True).start()

    def tearDown(self):
        self.proxy.shutdown()
        self.proxy.server_close()

    def get(self,path,request_headers=headers):
        req=urllib.request.Request(f'http://127.0.0.1:{self.proxy.server_port}'+path,headers=request_headers)
        try: result=urllib.request.urlopen(req,timeout=5)
        except urllib.error.HTTPError as error: result=error
        with result: return result.status,json.load(result),result.headers

    def test_contract(self):
        self.assertEqual(self.get('/other')[0],404)
        self.assertEqual(self.get('/fetch',{'Origin':origin})[0],401)
        self.assertEqual(self.get('/fetch')[0],400)
        self.assertEqual(self.get('/fetch',{'Origin':'https://invalid.example'})[0],403)
        with patch.dict(globals_,fetch_url=lambda url:('<p>example</p>',url)):
            status,data,cors=self.get('/fetch?url='+urllib.parse.quote('https://example.com/?a=%20',safe=''))
            self.assertEqual((status,data['url'],cors['Access-Control-Allow-Origin']),(200,'https://example.com/?a=%20',origin))

    def test_target_policy(self):
        with patch.dict(globals_,resolve_host=lambda *_:[(None,None,None,None,('192.168.1.10',80))]):
            with self.assertRaises(p['FetchError']) as error:
                p['validate_target']('https://example.com',time.monotonic()+1)
            self.assertEqual(error.exception.status,403)
        with patch.dict(globals_,resolve_host=lambda *_:[(None,None,None,None,('93.184.216.34',80))]):
            self.assertEqual(p['validate_target']('https://example.com/path',time.monotonic()+1)[-1],'93.184.216.34')

    def test_busy(self):
        for _ in range(p['MAX_REQUESTS']): self.proxy.slots.acquire()
        self.assertEqual(self.get('/fetch?url=https://example.com/')[0],503)




