---
name: secret-in-write
description: Mencegah penulisan token API, kunci privat, atau kredensial ke dalam berkas
action: block
scope: tool:write, tool:edit, tool:hash_edit
condition:
  - '(?<![a-zA-Z0-9_$])(?:api[_-]?key|secret|token|password)\b\s*(?::|=(?!=))\s*(?:\\?["\x27][^"\x27\r\n]{8,}\\?["\x27])'
  - '(?<![a-zA-Z0-9_$])(?:api[_-]?key|secret|token|password)\b\s*=(?!=)\s*(?=[A-Za-z0-9_.-]{8,}(?:\s|[,;}"\x27\r\n]|$))(?=[A-Za-z0-9_.-]*[0-9])[A-Za-z0-9_.-]+'
  - '(?<![a-zA-Z0-9_$])api[_-]?key\b\s*=\s*\[REDACTED:[^\]\r\n]+\]'
  - 'sk-[A-Za-z0-9_-]{20,}'
  - '(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}'
  - 'AKIA[0-9A-Z]{16}'
---
Penulisan rahasia (secret, API key, token, kredensial) ke berkas dilarang. Gunakan variabel lingkungan atau mock.
