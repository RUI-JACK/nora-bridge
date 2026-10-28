"""Nora bridge stdlib client. Never writes the bearer token to disk or argv."""
import argparse
import base64
import getpass
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import ipaddress
from pathlib import Path

class NoraClient:
    def __init__(self, token, base_url):
        self.token = token.strip()
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme != 'http' or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('Use http://<Tailscale IPv4>:<port> without credentials or a path')
        address = ipaddress.ip_address(parsed.hostname or '')
        if address.version != 4 or address not in ipaddress.ip_network('100.64.0.0/10') or not parsed.port:
            raise ValueError('Only a Tailscale IPv4 address with an explicit port is accepted')
        self.base_url = base_url.rstrip('/')
        # Do not send tailnet traffic or credentials through HTTP_PROXY.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method, route, body=None, key=None, binary=False):
        headers = {'Authorization': 'Bearer ' + self.token}
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        if key:
            headers['Idempotency-Key'] = key
        req = urllib.request.Request(self.base_url + route, data=data, headers=headers, method=method)
        with self.opener.open(req, timeout=28) as response:
            raw = response.read()
            return raw if binary else json.loads(raw)

    def run(self, route, body, on_chunk=None, key=None):
        key = key or str(uuid.uuid4())
        # Retries use the SAME key and body, including after a lost POST response.
        for attempt in range(3):
            try:
                job = self.request('POST', route, body, key)
                break
            except urllib.error.HTTPError:
                raise
            except (TimeoutError, OSError):
                if attempt == 2:
                    raise
                time.sleep(1)
        stdout, stderr = bytearray(), bytearray()
        first = job.copy()
        while True:
            out = base64.b64decode(job['stdout_base64'])
            err = base64.b64decode(job['stderr_base64'])
            stdout.extend(out)
            stderr.extend(err)
            if on_chunk:
                on_chunk(out, err)
            if job['state'] != 'running' and not job['has_more']:
                return {'first_response': first, 'final': job, 'stdout': bytes(stdout), 'stderr': bytes(stderr)}
            time.sleep(0.5)
            query = urllib.parse.urlencode({'stdout_offset': job['next_stdout_offset'], 'stderr_offset': job['next_stderr_offset']})
            for attempt in range(3):
                try:
                    job = self.request('GET', '/exec/' + job['job_id'] + '?' + query)
                    break
                except urllib.error.HTTPError:
                    raise
                except (TimeoutError, OSError):
                    if attempt == 2:
                        raise
                    time.sleep(1)


def read_token(token_file=None, data_dir=None):
    local = Path(token_file) if token_file else Path(data_dir or (Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local')) / 'NoraBridge')) / 'token.txt'
    if token_file:
        return local.read_text(encoding='utf-8').strip()
    if os.name == 'nt' and local.is_file():
        return local.read_text(encoding='utf-8').strip()
    return getpass.getpass('Nora bearer token (not saved): ')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', help='http://<Tailscale IPv4>:<port>')
    parser.add_argument('--data-dir', default=str(Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local')) / 'NoraBridge'))
    parser.add_argument('--token-file', help='Existing private token file; never pass the token value in argv')
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('health')
    for name in ('exec', 'ego'):
        run = sub.add_parser(name)
        run.add_argument('input', help='PowerShell command for exec; local .mjs path for ego')
        run.add_argument('--timeout', type=int, default=1800)
    upload = sub.add_parser('upload')
    upload.add_argument('local')
    upload.add_argument('remote')
    upload.add_argument('--overwrite', action='store_true')
    download = sub.add_parser('download')
    download.add_argument('remote')
    download.add_argument('local')
    args = parser.parse_args()
    fallback_dir = Path.home() / 'NoraBridge'
    if not (Path(args.data_dir) / 'config.json').is_file() and (fallback_dir / 'config.json').is_file():
        args.data_dir = str(fallback_dir)
    if not args.url:
        config_file = Path(args.data_dir) / 'config.json'
        if os.name == 'nt' and config_file.is_file():
            config = json.loads(config_file.read_text(encoding='utf-8-sig'))
            args.url = 'http://' + config['listen_ip'] + ':' + str(config['listen_port'])
        else:
            parser.error('--url is required on the Agent device')
    client = NoraClient(read_token(args.token_file, args.data_dir), args.url)
    if args.action == 'health':
        print(json.dumps(client.request('GET', '/health'), ensure_ascii=False, indent=2))
    elif args.action in ('exec', 'ego'):
        body = {'timeout_sec': args.timeout}
        body['command' if args.action == 'exec' else 'script'] = args.input if args.action == 'exec' else Path(args.input).read_text(encoding='utf-8')
        def emit(out, err):
            sys.stdout.buffer.write(out)
            sys.stdout.buffer.flush()
            sys.stderr.buffer.write(err)
            sys.stderr.buffer.flush()
        result = client.run('/' + args.action, body, emit)
        print('\n' + json.dumps({'job_id': result['final']['job_id'], 'state': result['final']['state'], 'exit_code': result['final']['exit_code']}), file=sys.stderr)
        sys.exit(result['final']['exit_code'] if result['final']['exit_code'] is not None else 1)
    elif args.action == 'upload':
        result = client.request('POST', '/file', {'path': args.remote, 'content_base64': base64.b64encode(Path(args.local).read_bytes()).decode('ascii'), 'overwrite': args.overwrite})
        print(json.dumps(result))
    else:
        data = client.request('GET', '/file?' + urllib.parse.urlencode({'path': args.remote}), binary=True)
        with open(args.local, 'xb') as output:
            output.write(data)
        print(json.dumps({'bytes': len(data), 'saved_to': args.local}))


if __name__ == '__main__':
    main()
