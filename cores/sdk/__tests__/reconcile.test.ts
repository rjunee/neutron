import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_RECONCILIATION_THRESHOLD,
  ReconciliationError,
  runReconciliation,
  type ReconciliationGuard,
} from '../reconcile.ts'

describe('reconcile — runReconciliation', () => {
  test('passes when derived equals source (no drift)', async () => {
    const g: ReconciliationGuard = {
      metric: 'total_sales',
      threshold: 0.01,
      derived: () => Promise.resolve(1000),
      source: () => Promise.resolve(1000),
    }
    await expect(runReconciliation([g])).resolves.toBeUndefined()
  })

  test('passes when drift is exactly at threshold', async () => {
    // |1010 - 1000| / 1000 = 0.01 — not > threshold
    const g: ReconciliationGuard = {
      metric: 'total_sales',
      threshold: 0.01,
      derived: () => Promise.resolve(1010),
      source: () => Promise.resolve(1000),
    }
    await expect(runReconciliation([g])).resolves.toBeUndefined()
  })

  test('throws ReconciliationError when drift > threshold', async () => {
    // |1020 - 1000| / 1000 = 0.02 > 0.01
    const g: ReconciliationGuard = {
      metric: 'total_sales',
      threshold: 0.01,
      derived: () => Promise.resolve(1020),
      source: () => Promise.resolve(1000),
    }
    await expect(runReconciliation([g])).rejects.toBeInstanceOf(
      ReconciliationError,
    )
  })

  test('aggregates multiple drift failures into one error', async () => {
    const guards: ReconciliationGuard[] = [
      {
        metric: 'total_sales',
        threshold: 0.01,
        derived: () => Promise.resolve(1100),
        source: () => Promise.resolve(1000),
      },
      {
        metric: 'orders',
        threshold: 0.01,
        derived: () => Promise.resolve(50),
        source: () => Promise.resolve(60),
      },
    ]
    try {
      await runReconciliation(guards)
      throw new Error('expected runReconciliation to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ReconciliationError)
      const recErr = err as ReconciliationError
      expect(recErr.failures).toHaveLength(2)
      expect(recErr.failures.map((f) => f.metric)).toEqual([
        'total_sales',
        'orders',
      ])
    }
  })

  test('captures derived() throw as guard_error failure', async () => {
    const g: ReconciliationGuard = {
      metric: 'total_sales',
      threshold: 0.01,
      derived: () => Promise.reject(new Error('duckdb timeout')),
      source: () => Promise.resolve(1000),
    }
    try {
      await runReconciliation([g])
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ReconciliationError)
      const recErr = err as ReconciliationError
      expect(recErr.failures[0]?.outcome).toBe('guard_error')
      expect(recErr.failures[0]?.cause).toBeInstanceOf(Error)
    }
  })

  test('captures non-finite metric as guard_error', async () => {
    const g: ReconciliationGuard = {
      metric: 'total_sales',
      threshold: 0.01,
      derived: () => Promise.resolve(Number.NaN),
      source: () => Promise.resolve(1000),
    }
    await expect(runReconciliation([g])).rejects.toBeInstanceOf(
      ReconciliationError,
    )
  })

  test('zero source: passes when derived also zero', async () => {
    const g: ReconciliationGuard = {
      metric: 'total_sales',
      threshold: 0.01,
      derived: () => Promise.resolve(0),
      source: () => Promise.resolve(0),
    }
    await expect(runReconciliation([g])).resolves.toBeUndefined()
  })

  test('zero source: fails when derived non-zero', async () => {
    const g: ReconciliationGuard = {
      metric: 'total_sales',
      threshold: 0.01,
      derived: () => Promise.resolve(1),
      source: () => Promise.resolve(0),
    }
    await expect(runReconciliation([g])).rejects.toBeInstanceOf(
      ReconciliationError,
    )
  })

  test('DEFAULT_RECONCILIATION_THRESHOLD is 0.01 (1%)', () => {
    expect(DEFAULT_RECONCILIATION_THRESHOLD).toBe(0.01)
  })

  test('guard with omitted threshold uses default 1% (Codex r5 P1)', async () => {
    // No threshold field → default kicks in. 5% drift exceeds the 1%
    // default and must throw.
    const g = {
      metric: 'total_sales',
      derived: () => Promise.resolve(1050),
      source: () => Promise.resolve(1000),
    } as ReconciliationGuard
    await expect(runReconciliation([g])).rejects.toBeInstanceOf(
      ReconciliationError,
    )
  })

  test('guard with omitted threshold passes for sub-1% drift', async () => {
    const g = {
      metric: 'total_sales',
      derived: () => Promise.resolve(1009),
      source: () => Promise.resolve(1000),
    } as ReconciliationGuard
    await expect(runReconciliation([g])).resolves.toBeUndefined()
  })

  test('ReconciliationError carries a human-readable message', async () => {
    const g: ReconciliationGuard = {
      metric: 'total_sales',
      threshold: 0.01,
      derived: () => Promise.resolve(1020),
      source: () => Promise.resolve(1000),
    }
    try {
      await runReconciliation([g])
      throw new Error('expected throw')
    } catch (err) {
      const recErr = err as ReconciliationError
      expect(recErr.message).toContain('total_sales')
      expect(recErr.message).toContain('drift=2')
    }
  })
})
