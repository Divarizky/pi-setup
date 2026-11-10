---
name: empty-validation
description: Deteksi frasa pembuka validasi kosong yang dilarang
action: log
scope: text
anchor: start
condition:
  - "You're absolutely right"
  - "Great question"
  - "Brilliant idea"
  - "Makes total sense"
  - '\bExactly\b'
  - '\bPerfect\b'
---
Hindari frasa validasi kosong pembuka. Langsung berikan jawaban teknis atau tindakan perbaikan tanpa basa-basi.
