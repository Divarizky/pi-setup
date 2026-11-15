---
name: git-commit-push
description: Membatasi commit dan push Git sesuai izin user untuk tiap operasi
action: block
scope: tool:bash
condition:
  - 'git\s+commit'
  - 'git\s+push'
unlessUserSays:
  - '\b(commit|push)\b'
---
Commit dan push Git memerlukan izin user yang mencakup operasi tersebut. Persetujuan commit tidak mencakup push; persetujuan pilihan ask_user berlaku bila pilihan yang dipilih secara eksplisit memuat seluruh operasi.
