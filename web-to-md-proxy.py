#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地代理脚本，配合 markdown-editor.html 的「网页转 Markdown」功能使用。
解决浏览器跨域限制和部分反爬问题。

用法：
    python web-to-md-proxy.py              # 启动本地代理
    python web-to-md-proxy.py --bookmark   # 生成浏览器书签小工具代码
"""

import argparse
import concurrent.futures
import gzip
import hmac
import io
import http.client
import ipaddress
import json
import re
import secrets
import socket
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urljoin, urlsplit

PORT = 8765
MAX_REQUESTS = 4
MAX_BYTES = 5 * 1024 * 1024
TIME_LIMIT = 20
MAX_REDIRECTS = 4
DEFAULT_ORIGINS = {'http://localhost:8080', 'http://127.0.0.1:8080', 'null'}
REDIRECTS = {301, 302, 303, 307, 308}
DNS_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=MAX_REQUESTS)
DNS_SLOTS = threading.BoundedSemaphore(MAX_REQUESTS)


class FetchError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def resolve_host(host, port, deadline):
    if not DNS_SLOTS.acquire(timeout=remaining(deadline)):
        raise TimeoutError()
    future = DNS_POOL.submit(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM)
    future.add_done_callback(lambda _: DNS_SLOTS.release())
    return future.result(timeout=remaining(deadline))


def validate_target(url, deadline):
    if re.search(r'[\s\\]', url):
        raise FetchError(400, 'Invalid URL')
    try:
        target = urlsplit(url)
        port = target.port or (443 if target.scheme == 'https' else 80)
        if target.scheme not in ('http', 'https') or not target.hostname or target.username is not None:
            raise ValueError()
        host = target.hostname.encode('idna').decode('ascii')
    except (ValueError, UnicodeError):
        raise FetchError(400, 'A valid HTTP(S) URL is required') from None
    addresses = resolve_host(host, port, deadline)
    for entry in addresses:
        address = ipaddress.ip_address(entry[4][0])
        address = getattr(address, 'ipv4_mapped', None) or address
        if not address.is_global or address.is_multicast or address.is_reserved or getattr(address, "is_site_local", False):
            raise FetchError(403, 'Only public network addresses are allowed')
    return target, host, port, addresses[0][4][0]


def remaining(deadline):
    timeout = deadline - time.monotonic()
    if timeout <= 0:
        raise TimeoutError()
    return timeout


def open_connection(scheme, host, port, address, deadline):
    if scheme == 'https':
        connection = http.client.HTTPSConnection(host, port, timeout=remaining(deadline), context=ssl.create_default_context())
    else:
        connection = http.client.HTTPConnection(host, port, timeout=remaining(deadline))

    connection._create_connection = lambda *_args, **_kwargs: socket.create_connection(
        (address, port), timeout=remaining(deadline)
    )
    return connection


def read_html(response, sock, deadline):
    data = bytearray()
    while True:
        sock.settimeout(remaining(deadline))
        chunk = response.read1(min(65536, MAX_BYTES + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_BYTES:
            raise FetchError(413, 'Upstream response exceeds the size limit')
    encoding = response.getheader('Content-Encoding', 'identity').strip().lower()
    if encoding == 'gzip':
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
            data = compressed.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise FetchError(413, 'Decoded response exceeds the size limit')
    elif encoding not in ('', 'identity'):
        raise FetchError(502, 'Unsupported upstream content encoding')
    remaining(deadline)
    return data



def fetch_url(url):
    deadline = time.monotonic() + TIME_LIMIT
    for attempt in range(MAX_REDIRECTS + 1):
        target, host, port, address = validate_target(url, deadline)
        connection = open_connection(target.scheme, host, port, address, deadline)
        timer = None
        try:
            path = target.path or '/'
            if target.query:
                path += '?' + target.query
            connection.connect()
            sock = connection.sock

            def interrupt():
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

            timer = threading.Timer(remaining(deadline), interrupt)
            timer.daemon = True
            timer.start()
            path = quote(path, safe="/%?:@!$&'()*+,;=-._~[]")
            connection.request('GET', path, headers={
                'Accept': 'text/html,application/xhtml+xml,text/plain',
                'Accept-Encoding': 'gzip, identity',
                'User-Agent': 'Markdown Editor local web importer',
            })
            sock.settimeout(remaining(deadline))
            response = connection.getresponse()
            try:
                if response.status in REDIRECTS and response.getheader('Location'):
                    if attempt >= MAX_REDIRECTS:
                        raise FetchError(502, 'Too many upstream redirects')
                    url = urljoin(url, response.getheader('Location'))
                    continue
                if not 200 <= response.status < 300:
                    raise FetchError(502, f'Upstream returned HTTP {response.status}')
                raw = read_html(response, sock, deadline)
                charset = response.headers.get_content_charset('utf-8')
                try:
                    html = raw.decode(charset, errors='replace')
                except LookupError:
                    html = raw.decode('utf-8', errors='replace')
                return html, url
            finally:
                response.close()
        except (OSError, http.client.HTTPException):
            remaining(deadline)
            raise
        finally:
            if timer:
                timer.cancel()
            connection.close()


class ProxyServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, token, origins):
        super().__init__(address, Handler)
        self.token = token
        self.origins = origins
        self.slots = threading.BoundedSemaphore(MAX_REQUESTS)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def allowed_origin(self):
        origin = self.headers.get('Origin')
        port = self.server.server_port
        host = self.headers.get('Host', '').lower()
        if host not in {f'localhost:{port}', f'127.0.0.1:{port}'}:
            return False
        return origin is None or origin in self.server.origins

    def write_json(self, status, body):
        payload = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        if self.allowed_origin() and self.headers.get('Origin') is not None:
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Vary', 'Origin')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        if not self.allowed_origin() or urlsplit(self.path).path != '/fetch':
            self.write_json(403, {'error': 'Origin or endpoint is not allowed'})
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', 'null'))
        self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET')
        self.send_header('Access-Control-Allow-Headers', 'X-Markdown-Token')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()

    def do_GET(self):
        try:
            if not self.allowed_origin():
                raise FetchError(403, 'Origin or host is not allowed')
            parsed = urlsplit(self.path)
            if parsed.path != '/fetch':
                raise FetchError(404, 'Only /fetch endpoint is supported')
            supplied = self.headers.get('X-Markdown-Token', '').encode('utf-8')
            if not hmac.compare_digest(supplied, self.server.token.encode('utf-8')):
                raise FetchError(401, 'A matching pairing token is required')
            urls = parse_qs(parsed.query).get('url', [])
            if len(urls) != 1:
                raise FetchError(400, 'Exactly one URL is required')
            if not self.server.slots.acquire(blocking=False):
                raise FetchError(503, 'The local proxy is busy')
            try:
                html, final_url = fetch_url(urls[0])
            finally:
                self.server.slots.release()
        except FetchError as error:
            self.write_json(error.status, {'success': False, 'error': str(error)})
        except TimeoutError:
            self.write_json(504, {'success': False, 'error': 'The upstream request timed out'})
        except (OSError, EOFError, http.client.HTTPException, ValueError, UnicodeError):
            self.write_json(502, {'success': False, 'error': 'The upstream request failed'})
        else:
            self.write_json(200, {'success': True, 'html': html, 'url': final_url, 'length': len(html)})

    def log_message(self, _format, *_args):
        # Request paths contain the full target URL.
        pass


BOOKMARKLET_JS = r"""
javascript:(function(){
  function toMd(n){
    if(n.nodeType===3)return n.textContent.replace(/\s+/g,' ');
    if(n.nodeType!==1)return '';
    var t=n.tagName.toLowerCase(),c=Array.from(n.childNodes).map(toMd).join(''),h;
    switch(t){
      case 'h1':return '# '+c.trim()+'\n\n';
      case 'h2':return '## '+c.trim()+'\n\n';
      case 'h3':return '### '+c.trim()+'\n\n';
      case 'p':return c.trim()+'\n\n';
      case 'br':return '\n';
      case 'a':h=n.getAttribute('href')||'';return '['+c+']('+h+')';
      case 'strong':case 'b':return '**'+c+'**';
      case 'em':case 'i':return '*'+c+'*';
      case 'code':return '`'+c+'`';
      case 'pre':return '\n```\n'+c.trim()+'\n```\n\n';
      case 'ul':return Array.from(n.children).map(function(li){return '- '+toMd(li).trim();}).join('\n')+'\n\n';
      case 'ol':return Array.from(n.children).map(function(li,i){return (i+1)+'. '+toMd(li).trim();}).join('\n')+'\n\n';
      case 'blockquote':return '> '+c.trim().replace(/\n/g,'\n> ')+'\n\n';
      case 'hr':return '---\n\n';
      case 'div':case 'section':case 'article':return c.trim()+'\n\n';
      default:return c;
    }
  }
  var sel='article,[role=main],.post-content,.entry-content,.article-content,#js_content,.rich_media_content,.content,#content,main';
  var el=document.querySelector(sel)||document.body;
  el.querySelectorAll('script,style,nav,aside,header,footer,form,iframe,img,svg,video,audio,canvas,.ad,.ads,.sidebar,.comments').forEach(function(e){e.remove();});
  var md=toMd(el).replace(/\n{3,}/g,'\n\n').trim();
  var title=document.title||'';
  if(title)md='# '+title+'\n\n'+md;
  navigator.clipboard.writeText(md).then(function(){alert('已复制 Markdown，请回到编辑器粘贴');}).catch(function(){prompt('请复制以下内容：',md);});
})();
""".strip()


def print_bookmarklet():
    js = BOOKMARKLET_JS.replace('\n', '')
    print("=" * 60)
    print("浏览器书签小工具（Bookmarklet）")
    print("=" * 60)
    print("\n使用方法：")
    print("1. 复制下面整行代码（以 javascript: 开头）")
    print("2. 在浏览器书签栏右键 → 添加网页")
    print("3. 名称填「提取 Markdown」，网址粘贴复制的代码")
    print("4. 在知乎、微信公众号等已登录页面点击该书签，即可复制 Markdown\n")
    print(js)
    print("\n" + "=" * 60)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bookmark', '-b', action='store_true')
    parser.add_argument('--origin', action='append', default=[], help='Additional exact editor origin')
    args = parser.parse_args()
    if args.bookmark:
        print_bookmarklet()
        return
    token = secrets.token_urlsafe(24)
    server = ProxyServer(('127.0.0.1', PORT), token, DEFAULT_ORIGINS | set(args.origin))
    print(f"本地代理已启动: http://127.0.0.1:{PORT}")
    print(f"本次配对令牌: {token}", flush=True)
    print("在编辑器的本地代理设置中输入令牌。按 Ctrl+C 停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        server.server_close()


if __name__ == '__main__':
    main()
