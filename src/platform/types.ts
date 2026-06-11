/* Pin SKILL.md spec — see PIN_SKILL_SPEC.md */

export interface ArgOption {
  value: string
  label: string
}

export interface ArgSpec {
  name: string
  label: string
  type?: 'string' | 'number' | 'enum'
  /** Static enum — list of {value, label} the wizard renders as buttons.
   *  Use when you want full control over button text (e.g. localized labels). */
  options?: ArgOption[]
  /** Dynamic enum — call this action and render its result as choice buttons. */
  from_action?: string
  /** Path to the array on the from_action response (e.g. "formulas" or "data.accounts").
   *  Falls back to the source action's respond.choices.from when omitted. */
  from_path?: string
  select_key?: string
  display_key?: string
  input?: 'text'
  placeholder?: string
}

export interface ApiSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  auth?: string  // e.g. "bearer:MT_API_KEY"
  body?: Record<string, any>
  query?: Record<string, string>
}

export interface ChoiceSpec {
  /** Path on response (after data-unwrap) to an array */
  from: string
  /** Button text template (per-item, uses {{this.X}}) */
  button: string
  /** Action id to call when tapped */
  callback_action: string
  /** Args to pre-fill on the callback action (templated, uses {{this.X}}) */
  callback_args?: Record<string, string>
  /** Limit number of buttons (TG max 100 inline buttons per message) */
  limit?: number
}

export interface FindOneSpec {
  /** Path to array on response (or unwrapped data) */
  from: string
  /** Field on each item to match against */
  where: string
  /** Value to match (templated — may use {arg_name}) */
  equals: string
}

export interface FollowUpAction {
  /** Action id within the same skill (uses current args + previous response data) */
  action: string
  /** Override button label; falls back to the action's label */
  label?: string
  /** Args to forward — templated from current scope (response, data, found, args) */
  args?: Record<string, string>
}

export interface FollowUpUrl {
  /** Button label */
  label: string
  /** URL — templated from current scope */
  url: string
}

export interface RespondSpec {
  template?: string                    // text rendered above buttons (or alone)
  choices?: ChoiceSpec                 // generates inline buttons from response data
  find_one?: FindOneSpec               // post-API filter; matched item exposed as {{found}}
  follow_up_actions?: FollowUpAction[] // action buttons appended after the rendered text
  follow_up_urls?: FollowUpUrl[]       // URL buttons (open external link)
  summarize_with?: string              // LLM prompt for unpredictable shapes
}

export type ActionVisibility = 'primary' | 'secondary' | 'callback_only' | 'hidden'

export interface ActionDef {
  id: string
  label: string
  description?: string
  /** Menu layout hint — see PIN_SKILL_SPEC. Auto-derived if omitted. */
  visibility?: ActionVisibility
  args: ArgSpec[]
  api?: ApiSpec
  script?: string
  handler?: string
  respond?: RespondSpec
  /** Action to invoke after user confirms a preview */
  preview?: { template: string; confirm_action: string }
  gated_by?: string[]
}

export interface NotifyButton {
  label: string
  action?: string                       // call this action when tapped
  args?: Record<string, string>         // templated args
  url?: string                          // OR open URL
}

export interface NotifySpec {
  template: string                      // text body (templated from webhook payload)
  buttons?: NotifyButton[]              // optional inline buttons
}

export interface WebhookSpec {
  /** Event name (used in URL: /webhooks/:skill/:event) */
  event: string
  /** Env var name holding shared secret for HMAC sig verification */
  secret?: string
  /** How to render the inbound notification to the user */
  notify: NotifySpec
}

export interface PinExtension {
  version: string
  icon?: string
  primary_color?: string
  secrets?: string[]
  actions: ActionDef[]
  webhooks?: WebhookSpec[]
}

export interface Skill {
  /** Canonical id = directory name = frontmatter.name */
  id: string
  /** Path to the skill directory */
  rootPath: string
  /** Frontmatter `name` field */
  name: string
  /** Frontmatter `description` field */
  description: string
  /** Markdown body (instructions for LLM) */
  body: string
  /** Pin extension (if present) */
  pin?: PinExtension
}

export interface ExecutionContext {
  chatId: number
  args: Record<string, any>
  priorOutputs: Record<string, any>  // results of prior actions, keyed by action id
}
