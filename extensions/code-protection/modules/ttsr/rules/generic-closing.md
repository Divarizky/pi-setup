---
name: generic-closing
description: Deteksi penutup basa-basi atau klise chatbot
action: log
scope: text
anchor: any
condition:
  - "Semoga (?:ini )?membantu"
  - "Hope this helps"
  - "Let me know if you"
  - "Feel free to ask"
  - "Ada yang bisa saya bantu lagi"
  - "Jangan ragu untuk"
---
Hindari penutup basa-basi atau klise chatbot. Akhiri respons begitu penyelesaian tugas atau penjelasan teknis selesai.
