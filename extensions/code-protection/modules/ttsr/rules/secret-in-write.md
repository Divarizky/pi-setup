---
name: secret-in-write
description: Mencegah penulisan token API, kunci privat, atau kredensial ke dalam berkas
action: block
scope: tool:write, tool:edit, tool:hash_edit
condition:
  - '(api[_-]?key|secret|token|password)[^a-zA-Z0-9_-]{1,10}[A-Za-z0-9_.-]{8,}'
  - 'sk-[A-Za-z0-9_-]{20,}'
  - '(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}'
  - 'AKIA[0-9A-Z]{16}'
---
Penulisan rahasia (secret, API key, token, kredensial) ke berkas dilarang. Gunakan variabel lingkungan atau mock.
