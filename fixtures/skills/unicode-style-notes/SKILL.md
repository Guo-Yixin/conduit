---
name: unicode-style-notes
description: "Write style notes that mix scripts and punctuation — éèüñ, 中文, العربية, emoji 🚀✨, and “curly quotes”. Use when the user writes “notes” or “メモ” in mixed scripts."
---

# Unicode Style Notes — a byte-faithful parsing fixture

This bundle exists to prove the parser is **deterministic and byte-faithful**: no locale-dependent
casing, no normalization that changes meaning, no accidental mangling of multi-byte sequences.

## Mixed scripts

- Accented Latin: café, naïve, façade, Zürich, jalapeño.
- CJK: 中文 测试 — 日本語のテスト — 한국어 테스트.
- Right-to-left Arabic: مرحبا بالعالم (this line starts RTL text inside an LTR document).
- Emoji, including multi-codepoint sequences: 🚀✨ 👩‍💻 (ZWJ-joined) 🏳️‍🌈 (ZWJ + variation selector).

## Punctuation oddities

“Curly double quotes”, ‘curly singles’, an em dash — like this, an en dash 1990–1999, an ellipsis…
and a non-breaking space between the words "no" and "break" here.

## Combining marks and zero-width characters

- Combining diacritics: é built from `e` + combining acute (e◌́), vs. precomposed é.
- Zero-width joiner and non-joiner appear inside this word: skil‌l‍craft (do not strip them).

## Whitespace edges

A line below ends with trailing whitespace (must round-trip byte-for-byte):
trailing spaces here   
Tabs	between	words	on	this	line.
