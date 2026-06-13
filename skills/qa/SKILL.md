---
name: qa
description: |
  Answer factual questions about Ultra Lab products — UltraProbe, Pin, MindThread, Ultra Advisor,
  UltraSite, UltraGrowth, and AVS scores.
  Use when someone asks "what is X", "how does Y work", "什麼是 X", or any factual question about Ultra Lab.
license: Proprietary (Ultra Lab)
compatibility: Requires BRAIN_MODE (ollama or gemini); reads skills/qa/knowledge/*.md at runtime
metadata:
  pin:
    version: "1.0"
    icon: 🤔
    primary_color: "#6366F1"
    actions:
      - id: ask
        label: 🤔 問問題
        description: Ask a factual question about Ultra Lab — products, features, how to get started
        args:
          - name: question
            label: 你想問什麼
            type: string
            input: text
            placeholder: 例如「UltraProbe 是什麼？」「Pin 怎麼綁定？」「AVS 是什麼？」
        handler: ask
---

# QA skill

Answers factual questions about Ultra Lab products by searching a local knowledge base
(`skills/qa/knowledge/*.md`) and feeding matching paragraphs to the LLM.

Phase 1: keyword/substring scoring (no vectors). Phase 2 will add embedding retrieval.

Red lines (refuses per HK/TW compliance):
- Investment / legal / medical advice

Out-of-scope fallback:
- If no KB entries match, returns an honest "no data" reply with an ultralab.tw link — never fabricates.

For LLM agents: invoke `ask` with `{ question: "..." }` and display the `rendered` text to the user.
Facts and source URLs come from the seed file `skills/qa/knowledge/ultralab-faq.md` — do not override them.
