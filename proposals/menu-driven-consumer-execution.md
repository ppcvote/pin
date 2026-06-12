# Discussion: Menu-driven consumer execution — when LLM routing is the wrong tool

> Category target: **Ideas** (or **Show and tell** if the maintainers prefer)
> Draft for posting to github.com/agentskills/agentskills/discussions

---

Hey — Min Yi, [Ultra Lab](https://ultralab.tw). Background: I've been merging upstream into Cisco AI Defense, Microsoft Agent Governance Toolkit, OWASP LLM Top 10, NVIDIA garak, UK AISI inspect_evals — all in the AI security / agent tooling lane. Mention it only because what I'm about to argue cuts across the consensus in this community, and I want to make clear it's not naïveté talking.

**Claim**: there is a large, fast-growing class of skill consumption — humans on messaging apps, paying for SaaS — where LLM-driven routing is the wrong primitive. The Agent Skills spec is silent on this lane. Some conventions in this lane belong in the standard (or at least in a sibling doc). I built a runtime to find out which.

## The use case (concrete, not hypothetical)

End users in Taiwan and Hong Kong. Real estate agents, insurance agents, MindThread customers paying for our automation SaaS. Three live products on the same runtime today: MindThread (Threads automation, 13 accounts × 4k+ posts/user), UD House (HK real-estate, 40+ listings, photo-driven listing creation), UltraGrowth (NT$2,990/mo managed digital service). All three: same SKILL.md format, same runtime, no LLM in the hot path.

What these users want — every single one, every day:

- See numbers (their listings / posts / leads / SEO movement)
- Create one thing (a listing draft from a photo; a Threads post from a topic and formula)
- Get notified when something lands (lead form submission, scheduled post published)
- Confirm a few mutations before they ship

That's it. No multi-step planning, no autonomous agents, no chitchat. The same handful of actions, every day, on **LINE** (TW/HK messenger of record — installing a custom app is a non-starter).

## Why LLM routing is wrong for this class

I shipped v1 with an LLM router on every freeform message. Within four days of dogfooding it was clear:

- **Cost stacks**. ~$0.001 per Gemini Flash call sounds free until 30+ messages/day/user × the same intent firing 3-4 times because the router was slightly off. At 100 paying users that's not free.
- **Latency is felt**. ~1.5s Gemini round-trip vs 200ms button tap. The 7× difference is the difference between "this responds" and "this is thinking". When the next user input fires another LLM call (wizard step 2), the perception is "this is slow".
- **Hallucinations cost trust**. "Send a post to @universe_signal_tw" once routed to the wrong account. Strict JSON output, hand-built schema, constrained decoding — didn't matter. One wrong post and the user stops typing freeform.
- **Predictability beats cleverness**. Users wanted to see what would happen *before* they tapped. "Type to me and I'll guess" is a worse UX than "here are your three buttons".

None of this is a surprise to anyone who's shipped a deterministic CLI. The interesting bit is that the Agent Skills community's center of gravity is the opposite — prose-body skills that an LLM reads and decides when to invoke. That's the right design for IDE-resident agents reading whole repos. It's the wrong design for a button on a phone.

## What we built — the deterministic-first runtime

Renamed our philosophy from "agent with skills" to "skills with optional agent". Deterministic path is the **main** path. LLM is one fallback among several, hidden behind a flag.

Concretely, in our `metadata.pin` extension (lives under the spec's documented vendor metadata surface):

- **Each `actions[]` entry is a button**. Author hand-writes `label`, `description`, an `api:` block, optional `args:` schema, optional `respond.template:` (Handlebars-ish). The button is the contract. The action is what runs.
- **Visibility tiers**: `primary` (top-level menu), `secondary` (overflow), `callback_only` (only reachable from another action's choice rows — auto-derived from `from_action` references, never appears in menus or LLM tool lists), `hidden`. Surfaces auto-layout.
- **Multi-step wizard**: when an action needs args, the runtime walks them one prompt at a time. `from_action` + `from_path` makes one action's response feed another action's choice buttons live — the LLM never has to enumerate "your accounts", the live API does.
- **Webhooks declared in the same place**. `metadata.pin.webhooks[]` says "when event X arrives, render this template, deliver to the user's channel with these buttons". HMAC-SHA256 signature mandatory, no opt-out, missing config rejects the inbound.
- **LLM routing is opt-in and cannot execute**. When the flag is on, the LLM picks one registered action + args. The deterministic pipeline then runs it (args validated, mutations preview-gated, confirms required). LLM output is constrained to a three-decision JSON: `execute`, `clarify` (≥2 plausible options → buttons), `none` (chitchat). Ambiguity → buttons every time. `POST/PUT/DELETE` actions get a forced preview turn even when the SKILL doesn't declare one. Injection / jailbreak filtered upstream of the LLM call by [@ppcvote/prompt-shield](https://npmjs.com/@ppcvote/prompt-shield).

The full spec extension is at [PIN_SKILL_SPEC.md](https://github.com/ppcvote/pin/blob/main/PIN_SKILL_SPEC.md). Code at [github.com/ppcvote/pin](https://github.com/ppcvote/pin). I'm explicitly **not** asking for any of these field names to be standardized — they all live under `metadata.pin` per the spec's extension surface, and that's the right boundary for vendor concerns.

But some of the *concepts* underneath might not be vendor concerns at all.

## What I want to discuss

Three questions, ordered by how much they actually matter:

### 1. Is "consumer skill consumption" a category the standard wants to acknowledge?

The current spec is deliberately silent on UI affordances. Correct decision — UI is downstream. But there's a class of consumers (end users in messaging apps, paying for SaaS) where the path from "skill loaded" to "user got value" has surface decisions that are *not* downstream: which actions get exposed, how to group them, when to ask vs guess, when to require confirmation. These shape author behavior. They shape what the standard's prose-body convention even means in practice.

If the working group views this as out of scope: please say so explicitly. It would help the second wave of runtimes decide whether they're building on the spec or alongside it. If it's in scope: there's a real conversation to have about visibility tiers, mutation marking, and webhook declarations existing as *concepts* in the standard even if their concrete schema lives in vendor metadata.

### 2. Where's the seam between agent-driven and human-driven invocation?

A skill author writing SKILL.md today knows the LLM will read the prose body and decide when to call. Same skill, run on Pin, gets invoked by a human tapping a button. The author may want **different** copy for these audiences:

- LLM context: "When to use this skill — invoke when the user is asking about Threads engagement, posting cadence, or content performance"
- Button label: "📊 看本月成效"

Some of our actions are explicitly human-only (creation wizards with photo upload). Some are agent-only by intent (bulk operations a human would never run). Right now this lives in `metadata.pin.actions[].visibility`. Should there be a spec-level convention like `human_label` / `agent_only: true` / `human_only: true`? Or should it stay vendor metadata forever?

I don't have a strong opinion on the schema — I have a strong opinion that the *concept* needs language we can share.

### 3. Is "preview required for mutations" a runtime concern or a spec primitive?

Our runtime forces a preview turn on any LLM-triggered POST/PUT/DELETE, even if the SKILL.md author didn't declare `preview:`. This caught a real bug: an LLM confident about an action's args is *exactly* when you want a human in the loop. Putting this responsibility on the skill author's self-discipline (declare your previews!) doesn't scale.

A spec-level convention — even just `mutates: true` as an optional hint, inferrable from `api.method` but explicit — would let runtimes apply consistent posture without each one re-deriving "is this dangerous". Or the working group could declare this entirely a runtime concern and not its problem. Either is a fine answer; the current silence isn't.

## Why I'm raising this now, not later

Two reasons.

**The conventions baked in by the first wave of runtimes will shape the second wave.** The spec is young enough that this is still moving. I'd rather have the consumer-surface question land *in* the conversation than discover later that nobody thought about it because nobody surfaced it.

**The pattern keeps showing up in side projects.** I keep seeing variants of "LLM as menu operator" — Telegram bots over GPT, Slack apps with action approval queues, Discord moderation tools with deterministic confirmation flows. Each re-invents visibility tiers, arg-collection wizards, mutation gates from scratch. Shared vocabulary, even just in a sibling doc, would save a lot of duplicate engineering and a lot of footguns being independently rediscovered.

## What I can offer

If this lane is worth carving out and the discussion goes somewhere:

- I'll share runtime numbers (downgrade rate, cost-per-bound-user, decision distribution under load) from real Taiwan + Hong Kong dogfood — it's the only deployment of its kind I know of that's actively serving paying customers in TW/HK CJK locales.
- I'll publish the spec extension and runtime patterns as a non-prescriptive doc in the spec's neighborhood — Pin's `metadata.pin` schema becoming a community reference, not a competing standard.
- I'll keep landing PRs upstream where extensions might belong in the core (already have the upstream track record to do this cleanly).

What I want from this thread: a read on whether anyone else cares about this lane, and a signal from the working group on whether it's in or out of scope. The rest follows from that.

— Min Yi · [github.com/ppcvote](https://github.com/ppcvote) · [Ultra Lab](https://ultralab.tw)
