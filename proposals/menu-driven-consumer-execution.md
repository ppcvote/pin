# Discussion: Menu-driven consumer execution — where LLM routing isn't the right primitive

> Category target: **Ideas** (or **Show and tell** if the maintainers prefer)
> Draft for posting to github.com/agentskills/agentskills/discussions
> Tone: problem-first; Pin shown as one data point, not a prescription.

---

Hi everyone — Min Yi from [Ultra Lab](https://ultralab.tw) here.

We've been building a runtime on top of the Agent Skills spec for an audience the spec wasn't originally optimized for, and the gap has been useful enough that I want to share it as a discussion rather than a feature proposal. There's a class of skill consumption — consumer-facing, button-driven, multi-tenant SaaS — where **picking the right action deterministically beats letting an LLM route to it**, and I think there's something worth saying about that here.

## The use case (concrete)

End users in Taiwan and Hong Kong. Real-estate agents, insurance agents, MindThread customers. They've paid for a SaaS product. They want to do four things in their workday:

- See some numbers (how their listings / posts / leads are performing)
- Create one thing (a listing draft from a photo; a new social post from a topic)
- Get notified when something new lands (a website lead form, a published post)
- Confirm a few writes before they go out

That's it. No multi-step planning, no autonomous agents, no chitchat. The same five actions, every day, on **LINE** (because in TW/HK the messaging app is LINE, not Telegram and definitely not a custom app).

We initially shipped this with an LLM router on every freeform message. Within a few days of dogfooding it was clear:

- **Cost**: ~$0.001 per message looks tiny until you realize a regular user types 30+ short messages a day and the same intent fires 3-4 times because the router was slightly off.
- **Latency**: Every Gemini Flash call is ~1.5s end-to-end. A user tapping a button gets a response in 200ms. The difference is felt, especially when the second tap fires a wizard step that wraps the same call.
- **Hallucination**: "Send a post to @universe_signal_tw" sometimes routed to the wrong account. Even with strict JSON output mode and a hand-built schema. Once was enough to lose trust.
- **Predictability**: Users wanted to know what would happen *before* they tapped. "Type to me and hope it does the right thing" was actively worse than "show me three buttons".

## What we ended up building

We renamed our run-loop philosophy from "agent with skills" to "skills with optional agent". The deterministic path is the main path. Specifically:

- Each `metadata.pin.actions[]` entry is a button. The skill author hand-writes `label`, `description`, an `api:` block, optional `args:`, optional `respond.template:`. The button is the contract — that's what runs when tapped.
- Visibility hints (`primary`, `secondary`, `callback_only`, `hidden`) let the runtime auto-layout the skill menu. Actions that need args from a previous step are correctly hidden from the top level (avoids "this needs the thing you didn't supply" deadlock UX).
- Multi-step actions go through a wizard that walks args one-prompt-at-a-time. `from_action` + `from_path` makes one action's response feed another action's choice buttons, so the LLM never has to enumerate "available accounts" — the live API does.
- LLM routing is opt-in (env flag) and even when on, it cannot execute. It can only nominate a registered tool name + args, which then go through the same deterministic pipeline (schema check, wizard, preview-on-mutation, confirm). The LLM's outputs are constrained to a three-decision JSON: `execute`, `clarify` (≥2 plausible options → buttons), or `none` (chitchat). Ambiguity → buttons every time.

That's the gist. The full spec is at [PIN_SKILL_SPEC.md](https://github.com/ppcvote/pin/blob/main/PIN_SKILL_SPEC.md). Code at [github.com/ppcvote/pin](https://github.com/ppcvote/pin). I'm not asking for this to be standardized — every field we added lives under `metadata.pin` per the spec's extension surface, and that's the right boundary.

## What I'd like to discuss

Three open questions, in order of how much they matter to me:

**1. Are consumer surfaces a category the standard wants to recognise?**

The current spec is well-tuned for agents that read prose + scripts and decide what to do. It's deliberately silent on UI affordances, which is correct — UI is downstream. But there's a class of consumers (end users in messaging apps, not developers in IDEs) where the path from "skill loaded" to "user got value" has surface decisions to make: which actions to expose, how to group them, when to ask vs guess, when to require confirmation. Some of these are conventions the community could share (e.g., visibility tiers, preview-on-mutation as a runtime concern), even if they live in vendor-specific metadata. **Is the working group interested in this lane existing alongside the prose-driven default?**

**2. Where's the seam between agent-driven and human-driven invocation?**

A skill author writing a SKILL.md today knows the LLM will read their prose body and pick when to invoke. But the same skill, run on Pin, gets invoked by a human tapping a button. The author may want to write **different** descriptions for these two audiences ("when to use this skill" for LLM context vs "what this button does" for the human). Is there room in the spec for a `human_label` / `human_description` convention, or should that stay in vendor metadata? Same question for: differing visibility in agent vs human contexts; allowing some actions to be human-only or agent-only.

**3. Is "preview required for mutations" a spec primitive or a runtime concern?**

When an LLM picks a `POST`/`PUT`/`DELETE` action, our runtime forces a preview turn even when the SKILL.md doesn't declare `preview:`. We do this because trusting the LLM's confidence on writes was a footgun. Should this be a runtime norm only, or worth adding a `mutates: true` hint to action declarations so any runtime can apply the same posture? (`mutates` would be inferrable from `api.method` anyway, but explicit might be cleaner.)

## Why this matters now

Two reasons I'm bringing this up rather than just shipping it quietly.

First, the spec is young enough that the conventions baked in by the first wave of runtimes will shape the second wave. If consumer use cases are a non-goal that's fine — saying so explicitly helps people decide whether to build on the spec or alongside it.

Second, I keep seeing variants of "LLM as menu operator" emerge in side projects, but each one re-invents visibility tiers / arg-collection wizards / preview wrappers from scratch. Some shared vocabulary in the discussion-or-docs layer (even if not in the spec) would help.

Happy to share more numbers from the runtime (downgrade rates, cost-per-bound-user, etc.) if useful. Most of all I'd love to know what fraction of the community thinks this lane is worth carving out at all.

— Min Yi · github.com/ppcvote · Ultra Lab
