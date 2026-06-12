// W5.2 demo dry-run — walks the TG-side mindthread post wizard headlessly
// up to the preview step (does NOT publish). Verifies every screen PPC will
// see while recording actually renders today.
process.env.PIN_DISABLE_FLYWHEEL = '1'

import { bootRegistry } from '../dist/platform/registry.js'
import { handlePinMessage } from '../dist/core/handle.js'

bootRegistry()

const uid = 'DEMO_DRYRUN_' + Date.now()
const base = { channelId: 'tg', userId: uid, userDisplayName: 'demo' }
const show = (label, r) => {
  console.log(`\n━━ ${label} ━━`)
  console.log(r?.text ?? '(no reply)')
  if (r?.buttons) console.log('buttons:', JSON.stringify(r.buttons.map(row => row.map(b => b.text))))
}

show('1. /start', await handlePinMessage({ ...base, text: '/start' }))
show('2. tap 🧵 mindthread', await handlePinMessage({ ...base, callback: 's:mindthread' }))
show('3. tap 幫我發一篇 ✨', await handlePinMessage({ ...base, callback: 'a:mindthread:post' }))
