#!/usr/bin/env python3
"""隔离工作区的 Bearer API 契约演练，不访问日常服务或使用真实凭据。"""
from contextlib import contextmanager
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from jsonschema import Draft202012Validator
from openapi_spec_validator import validate_spec
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parent.parent
SPEC_FILE = ROOT / 'backend/internal/httpapi/openapi.json'
SPEC = json.loads(SPEC_FILE.read_text())
REGISTRY = Registry().with_resource('urn:folio:openapi', Resource.from_contents(SPEC, default_specification=DRAFT202012))
HTTP_METHODS = {'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'}


def validate_operation_document(document, path, method):
    validate_spec(document)
    for key in ['openapi', 'info', 'servers', 'security']:
        assert document[key] == SPEC[key], (path, method, key)
    source = SPEC['paths'][path]
    selected = {key: value for key, value in source.items() if key not in HTTP_METHODS or key == method}
    assert document['paths'] == {path: selected}, (path, method, '操作或路径级继承字段不一致')
    components = {'securitySchemes': SPEC['components']['securitySchemes']}
    pending = [selected, components['securitySchemes']]
    visited = set()
    while pending:
        value = pending.pop()
        if isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, dict):
            pending.extend(value.values())
            if '$ref' not in value:
                continue
            ref = value['$ref']
            assert ref.startswith('#/components/'), ('不支持非本地组件引用', ref)
            parts = [part.replace('~1', '/').replace('~0', '~') for part in urllib.parse.unquote(ref[2:]).split('/')]
            resolved = document
            for part in parts:
                resolved = resolved[part]
            if ref in visited:
                continue
            visited.add(ref)
            _, category, name, *_ = parts
            component = SPEC['components'][category][name]
            components.setdefault(category, {})[name] = component
            pending.append(component)
    assert document['components'] == components, (path, method, '组件并非递归所需的最小闭包')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


@contextmanager
def isolated_server():
    with tempfile.TemporaryDirectory(prefix='folio-application-api-') as directory:
        base = Path(directory)
        workspace = base / 'workspace'
        workspace.mkdir()
        password = base / 'password'
        password.write_text('folio-application-api-password-2026')
        password.chmod(0o600)
        binary = base / ('folio.exe' if os.name == 'nt' else 'folio')
        subprocess.run(['go', 'build', '-o', str(binary), './cmd/server'], cwd=ROOT / 'backend', check=True, timeout=120)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        url = f'http://127.0.0.1:{port}'
        environment = {k: v for k, v in os.environ.items() if not k.startswith('FOLIO_')}
        environment.update(FOLIO_WORKSPACE=str(workspace), FOLIO_APP_DATA=str(base / 'data'), FOLIO_ADDR=f'127.0.0.1:{port}', FOLIO_ORIGIN=url, FOLIO_SECURE_COOKIE='false', FOLIO_PASSWORD_FILE=str(password))
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen([str(binary)], env=environment, stdout=log, stderr=log)
            try:
                for _ in range(200):
                    try:
                        with urllib.request.urlopen(url + '/api/v1/healthz', timeout=1):
                            break
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError('隔离测试服务启动失败')
                        time.sleep(.05)
                else:
                    raise RuntimeError('隔离测试服务就绪超时')
                yield url
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)


def main():
    validate_spec(SPEC)
    observed = set()
    calls = []
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with isolated_server() as base_url:
        def call(method, path, *, token=None, session=None, data=None, raw=None, headers=None, expected=200, documented=True):
            request_headers = dict(headers or {})
            request_headers['Origin'] = base_url
            if token:
                request_headers['Authorization'] = f'Bearer {token}'
            if session:
                request_headers['Cookie'], request_headers['X-CSRF-Token'] = session
            if data is not None:
                raw = json.dumps(data, ensure_ascii=False).encode()
                request_headers['Content-Type'] = 'application/json'
            request = urllib.request.Request(base_url + '/api/v1' + path, data=raw, headers=request_headers, method=method)
            try:
                response = client.open(request, timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status, result_headers, payload = response.status, response.headers, response.read()
            assert status == expected, f'{method} {path}: 预期 {expected}，实际 {status}'
            assert result_headers.get('Cache-Control') == 'no-store', (method, path)
            content_type = result_headers.get_content_type()
            body = json.loads(payload) if payload and content_type == 'application/json' else payload
            if documented:
                route = path.split('?')[0]
                if route.startswith('/trash/') and route.endswith('/restore'):
                    route = '/trash/{id}/restore'
                if route.startswith('/operations/'):
                    route = '/operations/{operationId}'
                op = SPEC['paths'][route]['get' if method == 'HEAD' else method.lower()]
                observed.add(op['operationId'])
                schema_response = op['responses'][str(status)]
                if '$ref' in schema_response:
                    schema_response = SPEC['components']['responses'][schema_response['$ref'].split('/')[-1]]
                if method != 'HEAD' and schema_response.get('content'):
                    assert content_type in schema_response['content'], (method, path, status, content_type)
                if method != 'HEAD' and content_type == 'application/json':
                    schema = schema_response['content']['application/json']['schema']
                    if '$ref' in schema:
                        schema = {'$ref': 'urn:folio:openapi' + schema['$ref']}
                    Draft202012Validator(schema, registry=REGISTRY).validate(body)
                calls.append({'operationId': op['operationId'], 'method': method, 'status': status})
            return body, result_headers

        def login(username, password):
            body, headers = call('POST', '/auth/login', data={'username': username, 'password': password}, documented=False)
            return headers['Set-Cookie'].split(';')[0], body['csrfToken']

        public, _ = call('GET', '/openapi.json')
        assert public == SPEC
        guide, headers = call('GET', '/agent.md')
        assert guide == (ROOT / 'backend/internal/httpapi/AGENT.md').read_bytes()
        assert headers.get_content_type() == 'text/markdown'
        index, _ = call('GET', '/operations')
        expected_index = {
            operation['operationId']: {
                'operationId': operation['operationId'],
                'method': method.upper(),
                'path': path,
                'summary': operation['summary'],
                'permissions': operation.get('x-folio-permissions', {}),
                'public': operation.get('security', SPEC.get('security', [])) == [],
                'contract': '/api/v1/operations/' + operation['operationId'],
            }
            for path, methods in SPEC['paths'].items()
            for method, operation in methods.items() if method in HTTP_METHODS
        }
        assert {key: value for key, value in index.items() if key != 'operations'} == {
            'apiVersion': 'v1', 'basePath': '/api/v1',
            'guide': '/api/v1/agent.md', 'openapi': '/api/v1/openapi.json',
        }
        assert len(index['operations']) == len(expected_index) == 28
        assert {entry['operationId']: entry for entry in index['operations']} == expected_index
        # 仅遍历这份有限索引，详情即使描述索引接口也不再次递归发请求。
        for entry in index['operations']:
            document, _ = call('GET', entry['contract'].removeprefix('/api/v1'))
            validate_operation_document(document, entry['path'], entry['method'].lower())
        document_routes = ['/openapi.json', '/agent.md', '/operations', '/operations/readContent']
        for route in document_routes:
            anonymous, _ = call('GET', route)
            invalid, headers = call('GET', route, token='invalid', headers={'X-Folio-Workspace': 'invalid'})
            assert invalid == anonymous
            assert headers.get('Set-Cookie') is None and headers.get('WWW-Authenticate') is None
            assert headers.get('X-Content-Type-Options') == 'nosniff'
            for credential in [None, 'invalid']:
                empty, headers = call('HEAD', route, token=credential)
                assert empty == b''
                assert headers.get('Set-Cookie') is None and headers.get('WWW-Authenticate') is None
        for credential in [None, 'invalid']:
            error, _ = call('GET', '/operations/unknown-operation', token=credential, expected=404)
            assert error['error']['code'] == 'operation_not_found'
            empty, _ = call('HEAD', '/operations/unknown-operation', token=credential, expected=404)
            assert empty == b''

        admin = login('admin', 'folio-application-api-password-2026')

        def new_token(session, permissions):
            return call('POST', '/user/tokens', session=session, data={'name': '契约演练', 'expiresAt': 0, 'permissions': permissions}, expected=201, documented=False)[0]

        all_permissions = {'files': 'write', 'search': 'write', 'trash': 'write'}
        writer = new_token(admin, all_permissions)
        reader = new_token(admin, {'files': 'read', 'search': 'read', 'trash': 'read'})
        searcher = new_token(admin, {'files': 'none', 'search': 'read', 'trash': 'none'})
        token = writer['token']
        # 鉴权和 Cookie CSRF 必须先于缺失 path、版本或正文的参数错误。
        call('GET', '/files/content', expected=401)
        call('PUT', '/files/content', token='invalid', data={}, expected=401)
        call('PUT', '/files/content', token=reader['token'], data={}, expected=403)
        call('PUT', '/files/content', session=(admin[0], ''), data={}, expected=403)
        call('POST', '/files', token='invalid', data={}, expected=401)
        call('POST', '/directories', token=reader['token'], data={}, expected=403)

        def assert_path_missing(response, expected):
            error = response['error']
            assert error['code'] == 'path_missing', error
            assert error['details']['expected'] == expected, error
            assert 'currentRevision' not in error['details'], error
            assert expected.split(':')[0] in error['message'], error

        for endpoint in ['/files', '/directories']:
            for misplaced in [{}, {'path': ''}, {'path': None}]:
                for query in ['', '?path=should-not-create']:
                    error, _ = call('POST', endpoint + query, token=token, data={'content': '禁止创建', **misplaced} if endpoint == '/files' else misplaced, expected=400)
                    assert_path_missing(error, 'body:path')
            error, _ = call('POST', endpoint, token=token, data={'path': 42, 'content': '禁止创建'} if endpoint == '/files' else {'path': 42}, expected=400)
            assert error['error']['code'] == 'invalid_request', error
            error, _ = call('POST', endpoint, token=token, data={'path': '../outside', 'content': '禁止创建'} if endpoint == '/files' else {'path': '../outside'}, expected=400)
            assert error['error']['code'] == 'path_invalid', error
            assert 'currentRevision' not in (error['error']['details'] or {}), error
        call('GET', '/workspace/tree', token=token)
        call('GET', '/workspace/tree?path=', token=token)
        anonymous, challenge = call('GET', '/workspace/usage', expected=401)
        assert '缺少访问令牌' in anonymous['error']['message'] and 'Bearer' in challenge['WWW-Authenticate']
        call('GET', '/application', expected=401)
        call('GET', '/application', session=admin, expected=403)
        _, challenge = call('GET', '/application', token='invalid', session=admin, expected=401)
        assert 'Bearer' in challenge['WWW-Authenticate']
        identity, _ = call('GET', '/application', token=token)
        assert identity['token']['permissions'] == all_permissions
        assert identity['token']['id'] == writer['id'] and identity['token']['name'] == '契约演练'
        assert not any(key in identity['user'] for key in ['csrfToken', 'admin', 'password'])
        assert token not in json.dumps(identity)
        call('GET', '/application', token=searcher['token'])
        call('POST', '/directories', token=reader['token'], data={'path': '禁止写入'}, expected=403)
        call('POST', '/directories', token=token, data={'path': '资料'}, expected=201)
        call('POST', '/directories', token=token, data={'path': '资料/子目录'}, expected=201)
        original = '\ufeff# 原始正文\r\n\r\n中文与 emoji 📝\n<!-- 必须保留 -->\r'
        created, _ = call('POST', '/files', token=token, data={'path': '资料/笔记.md', 'content': original, 'encoding': 'utf-8'}, expected=201)
        path = '/files/content?path=' + urllib.parse.quote('资料/笔记.md')
        disk, disk_headers = call('GET', path, token=token)
        assert disk['content'] == original
        required_path_operations = [
            (route, method.upper())
            for route, methods in SPEC['paths'].items()
            for method, operation in methods.items() if method in HTTP_METHODS
            if any(parameter['name'] == 'path' and parameter['in'] == 'query' and parameter.get('required')
                   for parameter in operation.get('parameters', []))
        ]
        assert len(required_path_operations) == 10
        for route, method in required_path_operations:
            for query in ['', '?path=']:
                # body 中即使带合法 path，也不能代替 query；同时缺 If-Match 仍先报 path。
                error, _ = call(method, route + query, token=token, data={'path': '资料/笔记.md', 'content': '禁止覆盖'}, expected=400)
                assert_path_missing(error, 'query:path')
                error, _ = call(method, route + query, token=token, raw=b'{', headers={'Content-Type': 'application/json', 'If-Match': disk_headers['ETag']}, expected=400)
                assert_path_missing(error, 'query:path')
            body = {'diff': '@@ -1 +1 @@\n-旧正文\n+禁止覆盖\n'} if method == 'PATCH' else {'content': '禁止覆盖'} if method == 'PUT' else None
            error, _ = call(method, route + '?path=../outside', token=token, headers={'If-Match': disk_headers['ETag']}, data=body, expected=400)
            assert error['error']['code'] == 'path_invalid', error
            assert 'currentRevision' not in (error['error']['details'] or {}), error
        # 修正位置后读取成功；更新仍不能绕过条件版本，也不能修改原文。
        corrected, corrected_headers = call('GET', path, token=token)
        assert corrected['content'] == original and corrected_headers['ETag'] == disk_headers['ETag']
        for method, route, body in [
            ('PUT', path, {'content': '禁止覆盖'}),
            ('PATCH', path, {'diff': 'invalid'}),
            ('DELETE', '/entries?path=' + urllib.parse.quote('资料/笔记.md'), None),
        ]:
            error, _ = call(method, route, token=token, data=body, expected=428)
            assert error['error']['code'] == 'precondition_required', error
        unchanged_path, _ = call('GET', path, token=token)
        assert unchanged_path['content'] == original and unchanged_path['revision'] == disk['revision']
        for content in ({}, {'content': None}):
            call('POST', '/files', token=token, data={'path': '资料/缺失.md', **content}, expected=400)
            call('PUT', path, token=token, data=content, headers={'If-Match': disk_headers['ETag']}, expected=400)
        call('GET', '/files/content?path=' + urllib.parse.quote('资料/缺失.md'), token=token, expected=404)
        unchanged_input, _ = call('GET', path, token=token)
        assert unchanged_input['content'] == original and unchanged_input['revision'] == disk['revision']
        tree_error, _ = call('GET', '/workspace/tree?path=' + urllib.parse.quote('资料/笔记.md'), token=token, expected=400)
        assert tree_error['error']['code'] == 'not_a_directory'
        for strict_path in ['资料/尾斜杠/', '资料/./点段']:
            call('POST', '/directories', token=token, data={'path': strict_path}, expected=400)
        metadata, _ = call('GET', '/files/metadata?path=' + urllib.parse.quote('资料/笔记.md'), token=token)
        assert metadata['mediaType'] == 'text/markdown' and metadata['viewer'] == 'markdown'
        for noop in ['@@ -1 +1 @@\n # 原始正文\n', '@@ -1 +1 @@\n-# 原始正文\n+# 原始正文\n']:
            result, noop_headers = call('PATCH', path, token=token, data={'diff': noop}, headers={'If-Match': disk_headers['ETag']})
            assert not result['changed'] and result['addedLines'] == result['deletedLines'] == 0
            assert noop_headers['ETag'] == disk_headers['ETag'] and 'savedAt' not in result
        selected, selected_headers = call('GET', path + '&startLine=2&lineCount=2', token=reader['token'], headers={'If-Match': disk_headers['ETag']})
        assert selected['content'] == '\r\n中文与 emoji 📝\n' and selected['totalLines'] == 4
        assert selected['startLine'] == 2 and selected['endLine'] == 3 and selected['nextLine'] == 4
        assert selected['isPartial'] and selected['hasMore'] and selected['revision'] == disk['revision']
        assert selected_headers['ETag'] == disk_headers['ETag']
        assert selected['size'] == disk['size'] and selected['returnedSize'] == len(selected['content'].encode())
        first, _ = call('GET', path + '&lineCount=1', token=token)
        assert first['content'] == '\ufeff# 原始正文\r\n'
        call('GET', path + '&startLine=2&lineCount=1', token=searcher['token'], expected=403)
        call('GET', path, token=searcher['token'], expected=403)
        range_source = ''.join(f'第 {i} 行\n' for i in range(1, 232))
        range_created, _ = call('POST', '/files', token=token, data={'path': '资料/按行.txt', 'content': range_source}, expected=201)
        range_path = '/files/content?path=' + urllib.parse.quote('资料/按行.txt')
        range_etag = '"' + range_created['revision'] + '"'
        hundred, _ = call('GET', range_path + '&lineCount=100', token=reader['token'])
        assert hundred['lineCount'] == 100 and hundred['endLine'] == 100 and hundred['nextLine'] == 101 and hundred['totalLines'] == 231
        window, _ = call('GET', range_path + '&startLine=50&lineCount=30', token=reader['token'], headers={'If-Match': range_etag})
        assert window['content'] == ''.join(f'第 {i} 行\n' for i in range(50, 80))
        assert window['endLine'] == 79 and window['nextLine'] == 80 and window['lineCount'] == 30
        tail, _ = call('GET', range_path + '&startLine=201', token=token)
        assert tail['lineCount'] == 31 and tail['requestedLineCount'] == 100 and not tail['hasMore'] and tail['isPartial']
        beyond, _ = call('GET', range_path + '&startLine=500&lineCount=30', token=token)
        assert beyond['content'] == '' and beyond['lineCount'] == beyond['endLine'] == beyond['nextLine'] == 0
        call('GET', range_path + '&lineCount=1001', token=token, expected=400)
        call('GET', range_path + '&startLine=0', token=token, expected=400)
        call('GET', range_path + '&lineCount=1&lineCount=2', token=token, expected=400)
        empty, range_headers = call('HEAD', range_path + '&startLine=50&lineCount=30', token=reader['token'])
        assert empty == b'' and range_headers['ETag'] == range_etag
        call('PUT', range_path, token=token, data={'content': range_source + '新增末行\n'}, headers={'If-Match': range_etag})
        call('GET', range_path + '&startLine=101&lineCount=100', token=token, headers={'If-Match': range_etag}, expected=412)
        revision, _ = call('GET', '/files/revision?path=' + urllib.parse.quote('资料/笔记.md'), token=token)
        assert revision['revision'] == disk['revision'] == created['revision']
        call('GET', '/entries/revision?path=' + urllib.parse.quote('资料'), token=token)
        call('GET', '/workspace/tree?path=' + urllib.parse.quote('资料') + '&offset=0&limit=1', token=token)
        patch = '@@ -3 +3 @@\n-中文与 emoji 📝\n+通过补丁修改的中文 📝\n'
        call('PATCH', path, token=token, data={'diff': patch}, expected=428)
        call('PATCH', path, token=reader['token'], data={'diff': patch}, headers={'If-Match': disk_headers['ETag']}, expected=403)
        preview, preview_headers = call('PATCH', path, token=token, data={'diff': patch, 'dryRun': True}, headers={'If-Match': disk_headers['ETag']})
        assert preview['changed'] and preview['dryRun'] and preview['revision'] == disk['revision']
        assert preview_headers['ETag'] == disk_headers['ETag'] and 'savedAt' not in preview
        unchanged, _ = call('GET', path, token=token)
        assert unchanged['content'] == original
        call('PATCH', path, token=token, data={'diff': '@@ -3 +3 @@\n-wrong\n+bad\n'}, headers={'If-Match': disk_headers['ETag']}, expected=409)
        call('PATCH', path, token=token, data={'diff': '*** invalid patch ***'}, headers={'If-Match': disk_headers['ETag']}, expected=400)
        patched, patched_headers = call('PATCH', path, token=token, data={'diff': patch}, headers={'If-Match': disk_headers['ETag']})
        assert patched['addedLines'] == 1 and patched['deletedLines'] == 1 and 'savedAt' in patched
        call('PATCH', path, token=token, data={'diff': patch}, headers={'If-Match': disk_headers['ETag']}, expected=412)
        original = original.replace('中文与 emoji 📝', '通过补丁修改的中文 📝')
        disk, disk_headers = call('GET', path, token=token)
        assert disk['content'] == original and patched_headers['ETag'] == disk_headers['ETag']
        for _ in range(100):
            patched_search, _ = call('GET', '/search?q=' + urllib.parse.quote('通过补丁修改的中文'), token=token)
            if any(item['path'] == '资料/笔记.md' for item in patched_search['entries']):
                break
            time.sleep(.05)
        else:
            raise AssertionError('补丁保存后的索引未反映新正文')

        updated_source = original + '\n追加的 API 正文\r\n'
        call('PUT', path, token=token, data={'content': updated_source}, expected=428)
        changed, _ = call('PUT', path, token=token, data={'content': updated_source, 'encoding': 'utf-8'}, headers={'If-Match': disk_headers['ETag']})
        call('PUT', path, token=token, data={'content': '禁止覆盖'}, headers={'If-Match': disk_headers['ETag']}, expected=412)
        call('POST', '/files', token=token, data={'path': '资料/笔记.md', 'content': '禁止覆盖'}, expected=409)
        call('GET', '/files/metadata?path=' + urllib.parse.quote('资料/笔记.md'), token=token)
        call('GET', '/settings', token=token)

        image = (ROOT / 'frontend/tests/fixtures/preview.png').read_bytes()
        binary = b'\x00\xff\x01\x02raw bytes\r\n'

        def multipart(name, payload):
            boundary = uuid.uuid4().hex
            body = f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + payload + f'\r\n--{boundary}--\r\n'.encode()
            return body, {'Content-Type': 'multipart/form-data; boundary=' + boundary}

        for suffix, name in [('', 'root-omitted.bin'), ('?directory=', 'root-empty.bin')]:
            raw, headers = multipart(name, binary)
            uploaded, _ = call('POST', '/uploads' + suffix, token=token, raw=raw, headers=headers, expected=201)
            assert uploaded['path'] == name

        malformed_boundary = uuid.uuid4().hex
        malformed = b''
        for name in ['rejected.bin', 'extra.bin']:
            malformed += f'--{malformed_boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n\r\n'.encode() + binary + b'\r\n'
        malformed += f'--{malformed_boundary}--\r\n'.encode()
        call('POST', '/uploads?directory=' + urllib.parse.quote('资料'), token=token, raw=malformed, headers={'Content-Type': 'multipart/form-data; boundary=' + malformed_boundary}, expected=400)
        call('GET', '/files/metadata?path=' + urllib.parse.quote('资料/rejected.bin'), token=token, expected=404)

        for name, payload in [('preview.png', image), ('raw.bin', binary)]:
            raw, headers = multipart(name, payload)
            call('POST', '/uploads?directory=' + urllib.parse.quote('资料'), token=token, raw=raw, headers=headers, expected=201)
            call('POST', '/uploads?directory=' + urllib.parse.quote('资料'), token=token, raw=raw, headers=headers, expected=409)
        downloaded, _ = call('GET', '/files/download?path=' + urllib.parse.quote('资料/raw.bin'), token=token)
        assert downloaded == binary
        partial, headers = call('GET', '/files/download?path=' + urllib.parse.quote('资料/raw.bin'), token=token, headers={'Range': 'bytes=0-3'}, expected=206)
        assert partial == binary[:4] and headers['Content-Range'] == f'bytes 0-3/{len(binary)}'
        empty, headers = call('HEAD', '/files/download?path=' + urllib.parse.quote('资料/raw.bin'), token=reader['token'])
        assert empty == b'' and int(headers['Content-Length']) == len(binary)
        call('GET', '/files/download?path=' + urllib.parse.quote('资料/raw.bin'), token=token, headers={'Range': 'bytes=999999-'}, expected=416)
        preview, headers = call('GET', '/files/preview?path=' + urllib.parse.quote('资料/preview.png'), token=token)
        assert preview == image and 'sandbox' in headers['Content-Security-Policy']
        for endpoint, name, payload in [('download', 'raw.bin', binary), ('preview', 'preview.png', image)]:
            stream_path = '/files/' + endpoint + '?path=' + urllib.parse.quote('资料/' + name)
            _, stream_headers = call('HEAD', stream_path, token=reader['token'])
            assert stream_headers['Last-Modified']
            part, _ = call('GET', stream_path, token=reader['token'], headers={'Range': 'bytes=0-3', 'If-Range': stream_headers['Last-Modified']}, expected=206)
            assert part == payload[:4]
            full, _ = call('GET', stream_path, token=reader['token'], headers={'Range': 'bytes=0-3', 'If-Range': 'Thu, 01 Jan 1970 00:00:00 GMT'})
            assert full == payload
        call('GET', '/files/preview?path=' + urllib.parse.quote('资料/笔记.md'), token=token, expected=415)
        invalid_path, _ = call('GET', '/files/download?path=../outside', token=token, expected=400)
        assert invalid_path['error']['code'] == 'path_invalid'
        assert 'currentRevision' not in (invalid_path['error']['details'] or {})

        call('PATCH', '/entries/move', token=token, data={'from': '资料/笔记.md', 'to': '资料/已移动.md'}, headers={'If-Match': '"' + changed['revision'] + '"'})
        moved_path = urllib.parse.quote('资料/已移动.md')
        call('GET', path, token=token, expected=404)
        moved, headers = call('GET', '/files/content?path=' + moved_path, token=token)
        assert moved['content'] == updated_source
        trashed, _ = call('DELETE', '/entries?path=' + moved_path, token=token, headers={'If-Match': headers['ETag']})
        trash, _ = call('GET', '/trash?offset=0&limit=1', token=token)
        assert trash['entries'][0]['id'] == trashed['id']
        call('POST', '/trash/' + trashed['id'] + '/restore', token=reader['token'], expected=403)
        call('POST', '/trash/' + trashed['id'] + '/restore', token=token)
        restored, _ = call('GET', '/files/content?path=' + moved_path, token=token)
        assert restored['content'] == updated_source
        for record_id in [trashed['id'], 'deadbeefdeadbeefdeadbeefdeadbeef']:
            error, _ = call('POST', '/trash/' + record_id + '/restore', token=token, expected=404)
            assert error['error']['code'] == 'trash_not_found'
        usage, _ = call('GET', '/workspace/usage', token=token)
        storage, _ = call('GET', '/workspace/storage', token=token)
        assert usage['used'] == storage['used'] == sum(item['bytes'] for item in storage['categories'])
        call('POST', '/search/rebuild', token=token, expected=202)
        for _ in range(100):
            status, _ = call('GET', '/search/status', token=token)
            if not status['indexing']:
                break
            time.sleep(.05)
        else:
            raise AssertionError('索引重建未在测试时限内结束')
        assert not status.get('warning'), '索引重建异常'
        search, _ = call('GET', '/search?q=' + urllib.parse.quote('追加的 API 正文'), token=searcher['token'])
        assert any(entry['path'] == '资料/已移动.md' for entry in search['entries'])
        call('GET', '/search?mode=names&q=' + urllib.parse.quote('已移动'), token=token)
        call('GET', '/search/file-status?path=' + moved_path + '&revision=' + restored['revision'], token=token)
        call('GET', '/search?mode=invalid', token=token, expected=400)
        call('POST', '/search/rebuild', token=reader['token'], expected=403)

        call('POST', '/admin/users', session=admin, data={'username': 'alice', 'password': 'alice-application-password-2026', 'enabled': True, 'quota': 1024}, expected=201, documented=False)
        alice = login('alice', 'alice-application-password-2026')
        other_token = new_token(alice, {'files': 'write', 'search': 'none', 'trash': 'none'})['token']
        call('GET', '/files/content?path=' + moved_path, token=other_token, session=admin, expected=404)
        call('POST', '/files', token=other_token, data={'path': 'quota.txt', 'content': 'x' * 2048}, expected=413)
        for method, route in [('GET', '/user/tokens'), ('GET', '/admin/users'), ('GET', '/shares'), ('DELETE', '/trash/' + trashed['id'])]:
            call(method, route, token=token, session=admin, expected=403, documented=False)
        call('DELETE', '/user/tokens/' + str(reader['id']), session=admin, documented=False)
        call('GET', '/application', token=reader['token'], expected=401)

    expected = {operation['operationId'] for methods in SPEC['paths'].values() for method, operation in methods.items() if method in HTTP_METHODS}
    assert expected == observed, f'未覆盖操作：{expected - observed}'
    output = ROOT / 'artifacts/application-api'
    output.mkdir(parents=True, exist_ok=True)
    report = {'source': '临时目录、隔离 Go 服务、纯 Bearer 应用请求；不访问日常服务', 'operations': len(observed), 'requests': calls, 'validators': {name: importlib.metadata.version(name) for name in ['openapi-spec-validator', 'jsonschema']}}
    (output / 'contract-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f'应用 API 契约与真实请求验证通过：{len(observed)} 个操作，{len(calls)} 个请求；含条件写入、原始字节、Range、HEAD、回收恢复、搜索及授权隔离。')


if __name__ == '__main__':
    main()
