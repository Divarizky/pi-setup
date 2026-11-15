---
name: tautology-test
description: Deteksi asersi tes tautologi tanpa pengujian semantik nyata
action: log
scope: tool:*
condition:
  - '\.test\.[a-zA-Z0-9_.-]+.*?(?:expect\(true\)\.toBe\(true\)|assert\s*\(\s*true\s*\)|expect\(1\)\.toBe\(1\)|not\.toThrow\(\))'
  - '(?:expect\(true\)\.toBe\(true\)|assert\s*\(\s*true\s*\)|expect\(1\)\.toBe\(1\)|not\.toThrow\(\)).*?\.test\.[a-zA-Z0-9_.-]+'
---
Hindari tes tautologi seperti expect(true).toBe(true). Setiap pengujian unit wajib menguji kontrak atau kegagalan yang nyata.
