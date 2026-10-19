/**
 * Unit tests for getFeeParams (src/utils.ts).
 *
 * Run with: bun test src/utils.test.ts
 *
 * Tests cover:
 * 1. Happy path EIP-1559 — maxFeePerGas is never below floor (MIN_BASE_FEE_WEI + priority).
 * 2. Low estimated values — floor is applied correctly.
 * 3. Legacy chain (gasPrice only) — normalised to EIP-1559 shape with floor applied.
 * 4. First call fails, second succeeds — retry works.
 * 5. Both calls fail — throws "Couldn't get the network fee. Try again."
 * 6. maxPriorityFeePerGas is always >= 1 gwei.
 */

import { describe, it, expect, mock } from 'bun:test'
import { getFeeParams } from './utils'
import type { PublicClient } from 'viem'

const ONE_GWEI = 1_000_000_000n
const MIN_BASE_FEE_WEI = 20n * ONE_GWEI  // mirrors utils.ts

function makeClient(results: Array<() => Promise<{
  maxFeePerGas?: bigint | null
  maxPriorityFeePerGas?: bigint | null
  gasPrice?: bigint | null
}>>): PublicClient {
  let call = 0
  return {
    estimateFeesPerGas: mock(async () => {
      const fn = results[call]
      call++
      if (!fn) throw new Error('unexpected call')
      return fn()
    }),
  } as unknown as PublicClient
}

describe('getFeeParams', () => {
  it('happy path EIP-1559 — maxFeePerGas never below floor', async () => {
    const mfpg = 50n * ONE_GWEI
    const mpfpg = 2n * ONE_GWEI
    const client = makeClient([async () => ({ maxFeePerGas: mfpg, maxPriorityFeePerGas: mpfpg })])
    const result = await getFeeParams(client)
    const floor = MIN_BASE_FEE_WEI + result.maxPriorityFeePerGas
    expect(result.maxFeePerGas >= floor).toBe(true)
    expect(result.maxFeePerGas).toBe(mfpg)
    expect(result.maxPriorityFeePerGas).toBe(mpfpg)
  })

  it('low estimated values — floor applied to maxFeePerGas', async () => {
    // Simulate a chain returning 1 gwei base — below the 20 gwei floor
    const client = makeClient([async () => ({ maxFeePerGas: 1n * ONE_GWEI, maxPriorityFeePerGas: 1n * ONE_GWEI })])
    const result = await getFeeParams(client)
    const expectedFloor = MIN_BASE_FEE_WEI + ONE_GWEI
    expect(result.maxFeePerGas).toBe(expectedFloor)
    expect(result.maxPriorityFeePerGas).toBe(ONE_GWEI)
  })

  it('legacy chain (gasPrice only) — normalised with floor applied', async () => {
    const client = makeClient([async () => ({ gasPrice: 5n * ONE_GWEI })])
    const result = await getFeeParams(client)
    // gasPrice < floor → floor kicks in
    const expectedFloor = MIN_BASE_FEE_WEI + ONE_GWEI
    expect(result.maxFeePerGas >= expectedFloor).toBe(true)
    expect(result.maxPriorityFeePerGas).toBe(ONE_GWEI)
  })

  it('retry — first call fails, second succeeds', async () => {
    const mfpg = 30n * ONE_GWEI
    const client = makeClient([
      async () => { throw new Error('timeout') },
      async () => ({ maxFeePerGas: mfpg, maxPriorityFeePerGas: 2n * ONE_GWEI }),
    ])
    const result = await getFeeParams(client)
    expect(result.maxFeePerGas).toBe(mfpg)
  })

  it('both calls fail — throws clear error', async () => {
    const client = makeClient([
      async () => { throw new Error('timeout') },
      async () => { throw new Error('timeout') },
    ])
    await expect(getFeeParams(client)).rejects.toThrow("Couldn't get the network fee. Try again.")
  })

  it('maxPriorityFeePerGas is always >= 1 gwei', async () => {
    // even if chain returns 0 priority fee
    const client = makeClient([async () => ({ maxFeePerGas: 40n * ONE_GWEI, maxPriorityFeePerGas: 0n })])
    const result = await getFeeParams(client)
    expect(result.maxPriorityFeePerGas >= ONE_GWEI).toBe(true)
  })

  it('floor invariant: maxFeePerGas >= MIN_BASE_FEE_WEI + priority for all inputs', async () => {
    // Fuzz-style: test many different fee combinations
    const cases: Array<{ mfpg: bigint; mpfpg: bigint }> = [
      { mfpg: 0n, mpfpg: 0n },
      { mfpg: 1n, mpfpg: 1n },
      { mfpg: 100n * ONE_GWEI, mpfpg: 5n * ONE_GWEI },
      { mfpg: 19n * ONE_GWEI, mpfpg: 1n * ONE_GWEI },
      { mfpg: 21n * ONE_GWEI, mpfpg: 1n * ONE_GWEI },
    ]
    for (const { mfpg, mpfpg } of cases) {
      const client = makeClient([async () => ({ maxFeePerGas: mfpg, maxPriorityFeePerGas: mpfpg })])
      const result = await getFeeParams(client)
      const floor = MIN_BASE_FEE_WEI + result.maxPriorityFeePerGas
      expect(result.maxFeePerGas >= floor).toBe(true)
    }
  })
})
