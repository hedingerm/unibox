import { describe, expect, it } from 'vitest'
import { unwrapIpcError } from '@shared/ipc-error'

describe('IPC error unwrapping', () => {
  it('strips Electron transport wording and the error class name', () => {
    const error = unwrapIpcError(
      new Error(
        "Error invoking remote method 'resend:setKey': ResendApiError: API key is invalid"
      )
    )
    expect(error.message).toBe('API key is invalid')
  })

  it('leaves a plain message untouched', () => {
    expect(unwrapIpcError(new Error('Kein Resend-API-Key hinterlegt')).message).toBe(
      'Kein Resend-API-Key hinterlegt'
    )
  })

  it('never produces an empty message', () => {
    expect(unwrapIpcError(new Error("Error invoking remote method 'x':")).message).not.toBe('')
  })
})
