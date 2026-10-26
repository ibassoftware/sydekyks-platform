#!/usr/bin/env python3
"""Exercise the built image on disposable Docker resources before publication."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

POSTGRES = 'pgvector/pgvector:0.8.1-pg16-trixie@sha256:1e4956185a7fd9306a41ee759a7b4329c4faf9a2bb91a1d01437310c97002433'
REDIS = 'redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499'
PREVIOUS_VERSION = '1.0.10'
PREVIOUS = f'ibassoftware/sydekyks:{PREVIOUS_VERSION}@sha256:5be614577d1a7749716f85143f13bd234a862978addb5657fc4006e7aff0dd6d'


def docker(*args, check=True):
    return subprocess.run(['docker', *args], capture_output=True, text=True, check=check).stdout.strip()


def request(base, path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        # Do not include authentication response bodies or tokens in CI logs.
        return error.code, None


def wait_for_app(base):
    deadline = time.monotonic() + 480
    while time.monotonic() < deadline:
        try:
            status, flags = request(base, '/api/v1/flags')
            if status == 200:
                return flags if isinstance(flags, dict) else {flag['id']: flag['value'] for flag in flags}
        except (OSError, ValueError):
            pass
        time.sleep(5)
    raise RuntimeError('Application did not become ready within eight minutes')


def exercise(image, upgrade=False):
    prefix = 'release-smoke-' + secrets.token_hex(5)
    app, pg, redis = [prefix + '-' + name for name in ('app', 'postgres', 'redis')]
    volume = prefix + '-files'
    sentinel = secrets.token_hex(16)
    password = 'Release!' + secrets.token_hex(16)
    env = {
        'POSTGRES_DB': 'sydekyks', 'POSTGRES_USER': 'sydekyks', 'POSTGRES_PASSWORD': password,
        'AP_EDITION': 'ce', 'AP_ENVIRONMENT': 'prod', 'AP_DB_TYPE': 'POSTGRES',
        'AP_POSTGRES_HOST': pg, 'AP_POSTGRES_PORT': '5432', 'AP_POSTGRES_DATABASE': 'sydekyks',
        'AP_POSTGRES_USERNAME': 'sydekyks', 'AP_POSTGRES_PASSWORD': password,
        'AP_REDIS_TYPE': 'STANDALONE', 'AP_REDIS_HOST': redis, 'AP_REDIS_PORT': '6379',
        'AP_INTERNAL_URL': 'http://127.0.0.1:80', 'AP_FRONTEND_URL': 'http://localhost:8080',
        'AP_ENCRYPTION_KEY': secrets.token_hex(16), 'AP_JWT_SECRET': secrets.token_hex(32),
        'AP_ALLOW_OPEN_SIGN_UP': 'false', 'AP_EXECUTION_MODE': 'SANDBOX_CODE_ONLY',
        'AP_WORKER_CONCURRENCY': '1', 'AP_EXECUTION_DATA_RETENTION_DAYS': '7',
        'AP_PAUSED_FLOW_TIMEOUT_DAYS': '7', 'AP_TELEMETRY_ENABLED': 'false',
        'AP_FILE_STORAGE_LOCATION': 'DB', 'AP_CONFIG_PATH': '/usr/src/app/.sydekyks',
    }
    with tempfile.TemporaryDirectory(prefix=prefix) as directory:
        env_path = Path(directory, 'runtime.env')
        env_path.write_text(''.join(f'{key}={value}\n' for key, value in env.items()))
        env_path.chmod(0o600)
        try:
            docker('network', 'create', prefix)
            docker('volume', 'create', volume)
            docker('run', '-d', '--name', pg, '--network', prefix, '--env-file', str(env_path), POSTGRES)
            docker('run', '-d', '--name', redis, '--network', prefix, REDIS)
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                ready = subprocess.run(['docker', 'exec', pg, 'pg_isready', '-U', 'sydekyks', '-d', 'sydekyks'], capture_output=True)
                if ready.returncode == 0:
                    break
                time.sleep(2)
            else:
                raise RuntimeError('Disposable database did not become ready')

            def start(selected):
                docker('run', '-d', '--name', app, '--network', prefix, '--env-file', str(env_path),
                       '-v', volume + ':/usr/src/app/.sydekyks', '-p', '127.0.0.1::80', selected)
                port = docker('port', app, '80/tcp').rsplit(':', 1)[1]
                base = 'http://127.0.0.1:' + port
                return base, wait_for_app(base)

            print('Testing ' + (f'upgrade from {PREVIOUS_VERSION}' if upgrade else 'fresh installation'), flush=True)
            base, flags = start(PREVIOUS if upgrade else image)
            email = 'release-smoke@example.com'
            status, owner = request(base, '/api/v1/authentication/sign-up', {
                'email': email, 'password': password, 'firstName': 'Release', 'lastName': 'Smoke',
                'trackEvents': False, 'newsLetter': False,
            })
            assert status in (200, 201) and owner.get('token') and owner.get('projectId'), 'Owner bootstrap failed'
            token = owner['token']
            status, mission = request(base, '/api/v1/flows', {'displayName': 'Release upgrade fixture', 'projectId': owner['projectId']}, token)
            assert status == 201 and mission.get('id'), 'Mission creation failed'
            mission_id = mission['id']
            status, agent = request(base, '/api/v1/agents', {
                'projectId': owner['projectId'], 'displayName': 'Release upgrade agent',
                'description': None, 'folderId': None, 'icon': 'bot', 'color': 'BLUE',
                'draft': {'instructions': 'Retain this saved agent through the upgrade.',
                          'provider': None, 'providerConfigId': None, 'modelName': None,
                          'modelTierId': None, 'tools': [], 'structuredOutput': [], 'maxSteps': 20},
            }, token)
            assert status == 201 and agent.get('id'), 'Saved agent creation failed'
            docker('exec', redis, 'redis-cli', 'SET', 'release:upgrade-fixture', sentinel)
            docker('exec', app, 'node', '-e',
                   "const fs=require('fs');fs.mkdirSync(process.env.AP_CONFIG_PATH,{recursive:true});"
                   "fs.writeFileSync(process.env.AP_CONFIG_PATH+'/release-upgrade-fixture',process.argv[1])", sentinel)

            def sql(query):
                return docker('exec', pg, 'psql', '-U', 'sydekyks', '-d', 'sydekyks', '-Atq', '-c', query)

            def saved_payloads():
                return sql("SELECT jsonb_build_object('missions', (SELECT jsonb_agg(jsonb_build_object('id', id, 'trigger', trigger, 'schemaVersion', \"schemaVersion\") ORDER BY id) FROM flow_version), 'agents', (SELECT jsonb_agg(jsonb_build_object('id', id, 'draft', draft, 'published', published, 'ownerId', \"ownerId\", 'projectId', \"projectId\") ORDER BY id) FROM agent))")

            before_payloads = saved_payloads()
            if upgrade:
                docker('rm', '-f', app)
                base, flags = start(image)

            assert flags.get('EDITION') == 'ce', 'Image must run in community edition'
            status, signed_in = request(base, '/api/v1/authentication/sign-in', {'email': email, 'password': password})
            assert status == 200 and signed_in.get('id') == owner['id'] and signed_in.get('projectId') == owner['projectId'], 'Owner/project did not survive'
            token = signed_in['token']
            status, saved = request(base, '/api/v1/flows/' + mission_id, token=token)
            assert status == 200 and saved.get('id') == mission_id, 'Saved Mission did not survive'
            assert saved_payloads() == before_payloads, 'Mission versions or saved agent configuration changed'
            status, saved_agent = request(base, '/api/v1/agents/' + agent['id'], token=token)
            assert status == 200 and saved_agent.get('draft') == agent['draft'], 'Saved agent did not survive'
            assert docker('exec', redis, 'redis-cli', 'GET', 'release:upgrade-fixture') == sentinel, 'Redis state changed'
            assert docker('exec', app, 'cat', '/usr/src/app/.sydekyks/release-upgrade-fixture') == sentinel, 'Application files changed'
            assert sql("SELECT count(*) FROM migrations WHERE name = 'SydekyksUpstreamOctober211882000000000'") == '1', 'Release migration was not applied'
            assert sql("SELECT count(*) FROM information_schema.columns WHERE table_name='platform_configuration' AND column_name='defaultChatModel'") == '1', 'Model configuration migration missing'
            assert sql("SELECT to_regclass('public.piece_translation') IS NOT NULL") == 't', 'Gadget translation migration missing'
            release = flags['CURRENT_VERSION']
            expected = json.loads(Path('package.json').read_text())['version']
            assert release == expected, 'Image reports the wrong platform version'
            query = urllib.parse.urlencode({'release': release, 'edition': 'ce'})
            status, registry = request(base, '/api/v1/pieces/registry?' + query, token=token)
            assert status == 200 and len(registry) > 0, 'Branded Gadget registry request failed'
            status, _ = request(base, '/api/v1/pieces/registry?release=invalid&edition=ce', token=token)
            assert status == 400, 'Malformed platform release was accepted'
            status, _ = request(base, '/api/v1/authentication/sign-up', {
                'email': 'uninvited@example.com', 'password': password, 'firstName': 'Uninvited',
                'lastName': 'User', 'trackEvents': False, 'newsLetter': False,
            })
            assert status in (400, 401, 403), 'Uninvited registration must remain closed'
            print(json.dumps({'scenario': 'upgrade' if upgrade else 'fresh', 'edition': 'ce',
                              'platformRelease': release, 'registryEntries': len(registry),
                              'ownerLogin': True, 'savedMission': True, 'savedAgent': True,
                              'missionVersionsPreserved': True, 'redisStatePreserved': True,
                              'applicationFilesPreserved': True, 'releaseMigrationApplied': True,
                              'upgradeFrom': PREVIOUS_VERSION if upgrade else None, 'closedRegistration': True}), flush=True)
        finally:
            for name in (app, pg, redis):
                docker('rm', '-f', '-v', name, check=False)
            docker('network', 'rm', prefix, check=False)
            docker('volume', 'rm', volume, check=False)


if __name__ == '__main__':
    image = sys.argv[1]
    inspect = json.loads(docker('image', 'inspect', image))[0]
    labels = inspect['Config']['Labels']
    assert labels['org.opencontainers.image.version'] == os.environ['RELEASE_VERSION']
    assert labels['org.opencontainers.image.revision'] == os.environ['SOURCE_REVISION']
    manifest = json.loads(docker('run', '--rm', image, 'cat', '/usr/src/app/release-manifest.json'))
    assert manifest['publicVersion'] == os.environ['RELEASE_VERSION']
    assert manifest['sourceRevision'] == os.environ['SOURCE_REVISION']
    docker('run', '--rm', image, 'sh', '-c',
           'test ! -e packages/ee && test ! -e packages/server/api/src/app/ee && '
           'test -s LICENSE.activepieces.txt && test -s LICENSE.sydekyks.txt && test -s LICENSE_SCOPE.md')
    exercise(image)
    exercise(image, upgrade=True)
