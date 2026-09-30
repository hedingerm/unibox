import { describe, expect, it } from 'vitest'
import { createTestApp } from '../helpers/app'

describe('following a link from a message', () => {
  it('opens http and mailto, and refuses everything else', async () => {
    const harness = createTestApp()
    try {
      await harness.app.api['shell:openUrl']('https://keller-farben.ch/shop')
      expect(harness.openedUrls).toContain('https://keller-farben.ch/shop')

      // Mail html reaches this call, so a scheme that would touch this machine
      // must not get through even if the sanitiser ever let one slip.
      await expect(harness.app.api['shell:openUrl']('file:///etc/passwd')).rejects.toThrow()
      await expect(
        harness.app.api['shell:openUrl']('javascript:alert(1)')
      ).rejects.toThrow()
      expect(harness.openedUrls).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })

  it('carries text to and from the system clipboard', async () => {
    const harness = createTestApp()
    try {
      await harness.app.api['clipboard:write']('https://keller-farben.ch/shop')
      expect(await harness.app.api['clipboard:read']()).toBe('https://keller-farben.ch/shop')
    } finally {
      harness.dispose()
    }
  })
})
