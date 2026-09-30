import { describe, expect, it } from 'vitest'
import { checkForUpdate, isNewerVersion } from '@main/update'

interface Recorder {
  confirmed: string[]
  installs: number
}

function harness(tag: string | null, answer = true) {
  const recorder: Recorder = { confirmed: [], installs: 0 }
  const deps = {
    currentVersion: '0.1.1',
    runGh: async () => tag,
    confirm: async (version: string) => {
      recorder.confirmed.push(version)
      return answer
    },
    install: () => {
      recorder.installs += 1
    }
  }
  return { deps, recorder }
}

describe('isNewerVersion', () => {
  it('compares component by component, not lexically', () => {
    expect(isNewerVersion('0.1.9', '0.1.10')).toBe(true)
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.20.0')).toBe(false)
  })

  it('accepts the tag with and without its v', () => {
    expect(isNewerVersion('0.1.1', 'v0.1.2')).toBe(true)
    expect(isNewerVersion('0.1.1', '0.1.1')).toBe(false)
  })

  it('treats anything unparseable as not newer', () => {
    expect(isNewerVersion('0.1.1', 'nightly')).toBe(false)
    expect(isNewerVersion('0.1.1', '')).toBe(false)
    expect(isNewerVersion('', '9.9.9')).toBe(false)
  })
})

describe('checkForUpdate', () => {
  it('offers and installs a newer release', async () => {
    const { deps, recorder } = harness('v0.1.2')
    const result = await checkForUpdate(deps)
    expect(result).toEqual({ latest: '0.1.2', installing: true })
    expect(recorder.confirmed).toEqual(['0.1.2'])
    expect(recorder.installs).toBe(1)
  })

  it('stays quiet when the release matches the running version', async () => {
    const { deps, recorder } = harness('v0.1.1')
    const result = await checkForUpdate(deps)
    expect(result).toEqual({ latest: '0.1.1', installing: false })
    expect(recorder.confirmed).toEqual([])
    expect(recorder.installs).toBe(0)
  })

  it('installs nothing when the user says later', async () => {
    const { deps, recorder } = harness('v0.2.0', false)
    const result = await checkForUpdate(deps)
    expect(result).toEqual({ latest: '0.2.0', installing: false })
    expect(recorder.confirmed).toEqual(['0.2.0'])
    expect(recorder.installs).toBe(0)
  })

  it('gives up silently when the CLI answers nothing', async () => {
    const { deps, recorder } = harness(null)
    const result = await checkForUpdate(deps)
    expect(result).toEqual({ latest: null, installing: false })
    expect(recorder.confirmed).toEqual([])
    expect(recorder.installs).toBe(0)
  })
})
