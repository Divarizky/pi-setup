---
name: git-commit-push
description: Mencegah eksekusi commit atau push git tanpa izin eksplisit
action: block
scope: tool:bash
condition:
  - 'git\s+commit'
  - 'git\s+push'
unlessUserSays:
  - '\b(commit|push)\b'
---
Operasi commit atau push git dilarang kecuali atas perintah eksplisit user.
