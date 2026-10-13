#!/usr/bin/env python3
"""Fail closed unless Docker Hub explicitly reports this public tag missing."""
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

version = sys.argv[1]
if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
    raise SystemExit('A stable release version is required')
query = urllib.parse.urlencode({'service': 'registry.docker.io', 'scope': 'repository:ibassoftware/sydekyks:pull'})
with urllib.request.urlopen('https://auth.docker.io/token?' + query, timeout=30) as response:
    token = json.load(response)['token']
request = urllib.request.Request(
    'https://registry-1.docker.io/v2/ibassoftware/sydekyks/manifests/' + version,
    method='HEAD', headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
    })
try:
    with urllib.request.urlopen(request, timeout=30):
        raise SystemExit('This release version already exists; it will not be overwritten')
except urllib.error.HTTPError as error:
    if error.code != 404:
        raise SystemExit('Cannot safely check release version: registry returned HTTP ' + str(error.code)) from None
print('Docker Hub confirms release ' + version + ' has not been published')
