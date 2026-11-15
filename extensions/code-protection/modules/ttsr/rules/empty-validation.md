---
name: empty-validation
description: Deteksi frasa pembuka validasi kosong yang dilarang
action: abort
scope: text
anchor: start
repeat: after-gap
repeatGap: 6
condition:
  - "You're absolutely right"
  - "Great question"
  - "Brilliant idea"
  - "Makes total sense"
  - '\bExactly(?=[!.,])'
  - '\bPerfect(?=[!.,])'
  - '(?:Anda|Kamu)?\s*benar sekali(?=[!.,])'
  - 'Tepat sekali(?=[!.,])'
  - 'Pertanyaan (?:yang )?(?:sangat )?bagus(?=[!.,])'
  - 'Ide (?:yang )?(?:sangat )?cemerlang(?=[!.,])'
  - 'Sangat masuk akal(?=[!.,])'
---
Hindari frasa validasi kosong pembuka. Langsung berikan jawaban teknis atau tindakan perbaikan tanpa basa-basi.
