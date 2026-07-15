import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  AuthenticatedSessionReference,
  ContentLockedUnitOfWorkExecution,
  ContentLockedUnitOfWorkRequest,
  ContentLockIssuanceScope,
  ContentLockPlanBindings,
  ContentLockPlanPort,
  ContentLockPlanShape,
  IssuanceContentLockSourceProjection,
  TransactionContentLockSourceProjection,
  VerifiedContentLockPlan,
} from '@/application/coordination'
import type { ContentReleaseCoordinate } from '@/application/coordination/content-lock-infrastructure'
import {
  bindContentLockedUnitOfWorkExecution,
  type ConsumedContentLockPlan,
  consumeVerifiedContentLockPlan,
  createContentLockPlanPort,
  createContentLockProjectionFactory,
} from './content-lock-plan'
import {
  createInstallationMutationEpoch,
  createSubjectDataGeneration,
} from './lifecycle-values'

const authSecret = 'test-auth-secret-with-at-least-thirty-two-bytes'
const epoch = createInstallationMutationEpoch('123e4567-e89b-42d3-a456-426614174000')
const anotherEpoch = createInstallationMutationEpoch(
  '223e4567-e89b-42d3-a456-426614174000',
)
const generation = createSubjectDataGeneration('323e4567-e89b-42d3-a456-426614174000')
const session = {} as AuthenticatedSessionReference
const methodology = {
  kind: 'methodology',
  id: 'methodology-development',
  version: '1',
} as const
const template = {
  kind: 'template',
  id: 'template-development',
  version: '1',
} as const

const methodologyFactory = createContentLockProjectionFactory('methodology-target')
const programsFactory = createContentLockProjectionFactory('programs-current')
const trainingFactory = createContentLockProjectionFactory('training-history')

type IssuanceSlots = {
  readonly methodology?: readonly ContentReleaseCoordinate[]
  readonly programs?: readonly ContentReleaseCoordinate[]
  readonly training?: readonly ContentReleaseCoordinate[]
}

function operationForShape(
  shape: ContentLockPlanShape,
): ContentLockedUnitOfWorkRequest['operation'] {
  if (shape === 'none') return 'subject-product-mutation'
  if (shape === 'release-revocation') return 'content-release-revocation'
  return shape
}

function bindings<Shape extends ContentLockPlanShape>(
  shape: Shape,
): ContentLockPlanBindings & { readonly shape: Shape } {
  return {
    shape,
    purpose: operationForShape(shape),
    actorAccountId: 'actor-account',
    subjectId: shape === 'release-revocation' ? null : 'subject-1',
    formOrCommandId: 'command-1',
    sourceEntityIds: ['source-1', 'source-2'],
    expectedEpoch: epoch,
    expectedGeneration: null,
  }
}

function port(resolveActorAccountId = vi.fn(async () => 'actor-account')): {
  readonly planPort: ContentLockPlanPort
  readonly resolveActorAccountId: typeof resolveActorAccountId
} {
  return {
    planPort: createContentLockPlanPort({ authSecret, resolveActorAccountId }),
    resolveActorAccountId,
  }
}

async function envelopeFor(
  planPort: ContentLockPlanPort,
  planBindings: ContentLockPlanBindings,
  options: IssuanceSlots,
): Promise<string> {
  return planPort.withIssuanceScope(planBindings, async ({ scope, seal }) => {
    const fragments = []
    if (options.methodology) {
      fragments.push(
        methodologyFactory.createIssuanceProjection(scope, options.methodology),
      )
    }
    if (options.programs) {
      fragments.push(programsFactory.createIssuanceProjection(scope, options.programs))
    }
    if (options.training) {
      fragments.push(trainingFactory.createIssuanceProjection(scope, options.training))
    }
    return seal(fragments)
  })
}

function requestFor(
  plan: VerifiedContentLockPlan,
  planBindings: ContentLockPlanBindings,
): ContentLockedUnitOfWorkRequest {
  const operation = operationForShape(planBindings.shape)
  return {
    operation,
    authority: {
      kind: 'authenticated-session',
      actorUserId: 'actor-account',
      expectedRole: 'owner',
      session,
    },
    session: { kind: 'ordinary' },
    workflowPurpose: planBindings.purpose,
    expectedEpoch: planBindings.expectedEpoch,
    productFence: 'shared',
    subjectLock:
      planBindings.subjectId === null
        ? null
        : { subjectUserId: planBindings.subjectId, mode: 'exclusive' },
    content: { kind: 'verified', plan, bindings: planBindings },
    mode: { isolation: 'read-committed', access: 'read-write' },
  } as ContentLockedUnitOfWorkRequest
}

function executionFor<Result>(
  plan: VerifiedContentLockPlan,
  request: ContentLockedUnitOfWorkRequest,
  callback: (consumed: ConsumedContentLockPlan) => Result | Promise<Result>,
): ContentLockedUnitOfWorkExecution<Result> {
  const consumed = consumeVerifiedContentLockPlan(plan, request)
  consumed.activateCommandAuthorizers()
  consumed.newCommandAuthorizer.authorizeNewCommand()
  const execution = (async () => {
    try {
      const result = await callback(consumed)
      consumed.assertReadyToCommit(result)
      return result
    } finally {
      consumed.finish()
    }
  })()
  return bindContentLockedUnitOfWorkExecution(plan, execution)
}

function transactionFragments(
  consumed: ConsumedContentLockPlan,
  options: IssuanceSlots,
): readonly TransactionContentLockSourceProjection[] {
  const fragments: TransactionContentLockSourceProjection[] = []
  if (options.methodology) {
    fragments.push(
      methodologyFactory.createTransactionProjection(
        consumed.transactionScope,
        options.methodology,
      ),
    )
  }
  if (options.programs) {
    fragments.push(
      programsFactory.createTransactionProjection(
        consumed.transactionScope,
        options.programs,
      ),
    )
  }
  if (options.training) {
    fragments.push(
      trainingFactory.createTransactionProjection(
        consumed.transactionScope,
        options.training,
      ),
    )
  }
  return fragments
}

function decodedPayload(envelope: string): Record<string, unknown> {
  const encoded = envelope.split('.')[0]
  if (!encoded) throw new Error('missing payload')
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
}

function signRawPayload(payload: string): string {
  const key = createHmac('sha256', authSecret)
    .update('indigo-content-lock-plan-v1\0', 'utf8')
    .digest()
  const signature = createHmac('sha256', key).update(payload, 'utf8').digest('base64url')
  return `${Buffer.from(payload).toString('base64url')}.${signature}`
}

function withRequestBindings(
  request: ContentLockedUnitOfWorkRequest,
  patch: Partial<ContentLockPlanBindings>,
): ContentLockedUnitOfWorkRequest {
  if (request.content.kind !== 'verified') throw new Error('expected verified request')
  return {
    ...request,
    content: {
      ...request.content,
      bindings: { ...request.content.bindings, ...patch },
    },
  } as ContentLockedUnitOfWorkRequest
}

describe('Platform content lock plan', () => {
  it.each([
    ['none' as const, {}, []],
    [
      'release-revocation' as const,
      { methodology: [methodology] },
      ['methodology:methodology-development:1'],
    ],
    [
      'current-publication.initial' as const,
      { methodology: [template, methodology] },
      ['methodology:methodology-development:1', 'template:template-development:1'],
    ],
    [
      'current-publication.existing' as const,
      { programs: [methodology, template] },
      ['methodology:methodology-development:1', 'template:template-development:1'],
    ],
    [
      'stale-regeneration' as const,
      {
        methodology: [methodology, template],
        programs: [methodology, template],
      },
      ['methodology:methodology-development:1', 'template:template-development:1'],
    ],
    [
      'correction-closure' as const,
      {
        programs: [methodology, template],
        training: [methodology, template],
      },
      ['methodology:methodology-development:1', 'template:template-development:1'],
    ],
  ])('issues and verifies the closed %s shape', async (shape, slots, expectedKeys) => {
    const { planPort, resolveActorAccountId } = port()
    const planBindings = bindings(shape)
    const envelope = await envelopeFor(planPort, planBindings, slots)
    const payload = decodedPayload(envelope)

    expect(payload).toMatchObject({
      version: 'content-lock-plan-v1',
      shape,
      actorAccountId: 'actor-account',
      keys: expectedKeys,
    })
    expect(payload).not.toHaveProperty('expectedEpoch')
    expect(envelope).not.toContain('123e4567-e89b-42d3-a456-426614174000')

    const prepared = planPort.prepareEnvelope(envelope)
    expect(Object.keys(prepared)).toEqual([])
    const result = await planPort.withVerifiedContentLockPlan(
      prepared,
      planBindings,
      (verified) => {
        expect(Object.keys(verified)).toEqual([])
        const request = requestFor(verified, planBindings)
        return executionFor(verified, request, (consumed) => {
          expect(consumed.lockKeys).toEqual(expectedKeys)
          const fragments = transactionFragments(consumed, slots)
          if (fragments.length > 0) {
            consumed.attestor.assertCurrentLockedContentSet(fragments)
          }
          return 'verified'
        })
      },
    )
    expect(result).toBe('verified')
    expect(resolveActorAccountId).toHaveBeenCalledOnce()
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
  })

  it('attests only a fresh transaction-bound union and revokes retained fragments', async () => {
    const { planPort } = port()
    const planBindings = bindings('current-publication.existing')
    const slots = { programs: [methodology, template] } as const
    const envelope = await envelopeFor(planPort, planBindings, slots)
    let retainedFragment: TransactionContentLockSourceProjection | undefined
    let retainedConsumed: ConsumedContentLockPlan | undefined

    await planPort.withVerifiedContentLockPlan(
      planPort.prepareEnvelope(envelope),
      planBindings,
      (verified) =>
        executionFor(verified, requestFor(verified, planBindings), (consumed) => {
          retainedConsumed = consumed
          const [fresh] = transactionFragments(consumed, slots)
          if (!fresh) throw new Error('missing fresh fragment')
          retainedFragment = fresh
          expect(() =>
            consumed.attestor.assertCurrentLockedContentSet([fresh]),
          ).not.toThrow()
          expect(() => consumed.attestor.assertCurrentLockedContentSet([fresh])).toThrow(
            expect.objectContaining({ code: 'uow.scope-revoked' }),
          )
        }),
    )

    const closed = retainedConsumed
    if (!closed) throw new Error('consumed scope was not retained')
    expect(() =>
      programsFactory.createTransactionProjection(closed.transactionScope, [
        methodology,
        template,
      ]),
    ).toThrow(expect.objectContaining({ code: 'uow.scope-revoked' }))

    await expect(
      planPort.withVerifiedContentLockPlan(
        planPort.prepareEnvelope(envelope),
        planBindings,
        (verified) =>
          executionFor(verified, requestFor(verified, planBindings), (consumed) => {
            if (!retainedFragment) throw new Error('fragment was not retained')
            consumed.attestor.assertCurrentLockedContentSet([retainedFragment])
          }),
      ),
    ).rejects.toMatchObject({ code: 'content-lock-plan.stale' })
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
  })

  it('fails the execution when attestation is missing or stale even if the callback catches it', async () => {
    const { planPort } = port()
    const planBindings = bindings('current-publication.existing')
    const envelope = await envelopeFor(planPort, planBindings, {
      programs: [methodology, template],
    })

    await expect(
      planPort.withVerifiedContentLockPlan(
        planPort.prepareEnvelope(envelope),
        planBindings,
        (verified) =>
          executionFor(verified, requestFor(verified, planBindings), () => 'unattested'),
      ),
    ).rejects.toMatchObject({ code: 'content-lock-plan.stale' })

    await expect(
      planPort.withVerifiedContentLockPlan(
        planPort.prepareEnvelope(envelope),
        planBindings,
        (verified) =>
          executionFor(verified, requestFor(verified, planBindings), (consumed) => {
            const stale = programsFactory.createTransactionProjection(
              consumed.transactionScope,
              [methodology, { ...template, version: '2' }],
            )
            try {
              consumed.attestor.assertCurrentLockedContentSet([stale])
            } catch {
              // A workflow cannot turn a failed attestation into commit authority.
            }
            return 'must not commit'
          }),
      ),
    ).rejects.toMatchObject({ code: 'content-lock-plan.stale' })
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
  })

  it('treats a classified-new none plan as commit-ready without fabricating an owner attestation', async () => {
    const { planPort } = port()
    const planBindings = bindings('none')
    const envelope = await envelopeFor(planPort, planBindings, {})
    const resultValue = { kind: 'none-satisfied' }

    const result = await planPort.withVerifiedContentLockPlan(
      planPort.prepareEnvelope(envelope),
      planBindings,
      (verified) =>
        executionFor(verified, requestFor(verified, planBindings), (consumed) => {
          expect(consumed.lockKeys).toEqual([])
          expect(() => consumed.assertReadyToCommit(resultValue)).not.toThrow()
          return resultValue
        }),
    )

    expect(result).toBe(resultValue)
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
  })

  it('keeps capability state opaque under constructor and prototype reflection', async () => {
    const { planPort } = port()
    const planBindings = bindings('current-publication.initial')
    let retainedScope: ContentLockIssuanceScope | undefined
    let retainedProjection: IssuanceContentLockSourceProjection | undefined
    const envelope = await planPort.withIssuanceScope(
      planBindings,
      async ({ scope, seal }) => {
        retainedScope = scope
        retainedProjection = methodologyFactory.createIssuanceProjection(scope, [
          methodology,
          template,
        ])
        return seal([retainedProjection])
      },
    )
    const closedScope = retainedScope
    const closedProjection = retainedProjection
    if (!closedScope || !closedProjection) throw new Error('capabilities not retained')
    expect(
      (closedScope.constructor as unknown as Record<PropertyKey, unknown>).state,
    ).toBeUndefined()
    expect(
      (closedProjection.constructor as unknown as Record<PropertyKey, unknown>).data,
    ).toBeUndefined()
    expect(() => Reflect.construct(closedScope.constructor, [])).toThrow(
      expect.objectContaining({ code: 'content-lock-plan.invalid' }),
    )
    expect(() => Reflect.construct(closedProjection.constructor, [])).toThrow(
      expect.objectContaining({ code: 'content-lock-plan.invalid' }),
    )
    expect(() =>
      methodologyFactory.createIssuanceProjection(closedScope, [methodology]),
    ).toThrow(expect.objectContaining({ code: 'uow.scope-revoked' }))

    const prepared = planPort.prepareEnvelope(envelope)
    const preparedConstructor = prepared.constructor as unknown as Record<
      PropertyKey,
      unknown
    >
    expect(preparedConstructor.payload).toBeUndefined()
    expect(preparedConstructor.consume).toBeUndefined()
    expect(() => Reflect.construct(prepared.constructor, [])).toThrow(
      expect.objectContaining({ code: 'content-lock-plan.invalid' }),
    )

    await planPort.withVerifiedContentLockPlan(prepared, planBindings, (verified) => {
      const verifiedConstructor = verified.constructor as unknown as Record<
        PropertyKey,
        unknown
      >
      expect(verifiedConstructor.consume).toBeUndefined()
      expect(verifiedConstructor.childState).toBeUndefined()
      expect(() => Reflect.construct(verified.constructor, [])).toThrow(
        expect.objectContaining({ code: 'content-lock-plan.invalid' }),
      )
      const execution = executionFor(
        verified,
        requestFor(verified, planBindings),
        (consumed) => {
          const concreteAttestor = consumed.attestor as unknown as Record<
            PropertyKey,
            unknown
          >
          expect(Object.keys(concreteAttestor)).toEqual([])
          expect(concreteAttestor.assertReadyToCommit).toBeUndefined()
          expect(concreteAttestor.assertWriteAuthorized).toBeUndefined()
          expect(concreteAttestor.authorizeExactReplay).toBeUndefined()
          expect(concreteAttestor.authorizeNewCommand).toBeUndefined()
          expect(Reflect.ownKeys(Object.getPrototypeOf(concreteAttestor))).toEqual([
            'constructor',
            'assertCurrentLockedContentSet',
          ])
          expect(() =>
            consumeVerifiedContentLockPlan(verified, requestFor(verified, planBindings)),
          ).toThrow(expect.objectContaining({ code: 'uow.scope-revoked' }))
          consumed.attestor.assertCurrentLockedContentSet(
            transactionFragments(consumed, {
              methodology: [methodology, template],
            }),
          )
        },
      )
      const executionConstructor = execution.constructor as unknown as Record<
        PropertyKey,
        unknown
      >
      expect(executionConstructor.matches).toBeUndefined()
      expect(executionConstructor.promise).toBeUndefined()
      expect(() => Reflect.construct(execution.constructor, [])).toThrow(
        expect.objectContaining({ code: 'uow.scope-revoked' }),
      )
      return execution
    })

    await expect(
      planPort.withVerifiedContentLockPlan(prepared, planBindings, () => {
        throw new Error('consumed prepared plan must not enter')
      }),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })
  })

  it('performs malformed, tamper, size, and canonical checks before actor capture', async () => {
    const { planPort, resolveActorAccountId } = port()
    const planBindings = bindings('none')
    const envelope = await envelopeFor(planPort, planBindings, {})
    const [payload, signature] = envelope.split('.')
    const cases = [
      '',
      'not-an-envelope',
      `${payload}.${signature}x`,
      `${payload}=.${signature}`,
      `a.${'b'.repeat(maximumTestEnvelopeBytes())}`,
    ]
    for (const candidate of cases) {
      expect(() => planPort.prepareEnvelope(candidate)).toThrow(
        expect.objectContaining({ code: 'content-lock-plan.invalid' }),
      )
    }

    const parsed = decodedPayload(envelope)
    const noncanonical = JSON.stringify(parsed, null, 2)
    expect(() => planPort.prepareEnvelope(signRawPayload(noncanonical))).toThrow(
      expect.objectContaining({ code: 'content-lock-plan.invalid' }),
    )
    expect(resolveActorAccountId).not.toHaveBeenCalled()
  })

  it('rejects non-canonical UTF-8 bytes even when they decode to a signed replacement character', async () => {
    const { planPort } = port()
    const planBindings = {
      ...bindings('none'),
      formOrCommandId: 'command-\uFFFD',
    }
    const envelope = await envelopeFor(planPort, planBindings, {})
    const [encodedPayload, encodedSignature] = envelope.split('.')
    if (!encodedPayload || !encodedSignature) throw new Error('invalid test envelope')
    const payloadBytes = Buffer.from(encodedPayload, 'base64url')
    const replacement = Buffer.from('\uFFFD', 'utf8')
    const replacementIndex = payloadBytes.indexOf(replacement)
    expect(replacementIndex).toBeGreaterThanOrEqual(0)
    const malformedBytes = Buffer.concat([
      payloadBytes.subarray(0, replacementIndex),
      Buffer.from([0xff]),
      payloadBytes.subarray(replacementIndex + replacement.length),
    ])
    expect(malformedBytes.toString('utf8')).toBe(payloadBytes.toString('utf8'))

    expect(() =>
      planPort.prepareEnvelope(
        `${malformedBytes.toString('base64url')}.${encodedSignature}`,
      ),
    ).toThrow(expect.objectContaining({ code: 'content-lock-plan.invalid' }))
  })

  it('consumes a prepared plan before bounded actor capture can be entered concurrently', async () => {
    let releaseActor: () => void = () => undefined
    const actorBarrier = new Promise<void>((resolve) => {
      releaseActor = resolve
    })
    const resolveActorAccountId = vi.fn(async () => {
      await actorBarrier
      return 'actor-account'
    })
    const { planPort } = port(resolveActorAccountId)
    const planBindings = bindings('none')
    const envelope = await envelopeFor(planPort, planBindings, {})
    const prepared = planPort.prepareEnvelope(envelope)
    const callback = vi.fn((verified: VerifiedContentLockPlan<'none'>) =>
      executionFor(verified, requestFor(verified, planBindings), () => 'first'),
    )
    const first = planPort.withVerifiedContentLockPlan(prepared, planBindings, callback)
    await vi.waitFor(() => expect(resolveActorAccountId).toHaveBeenCalledOnce())

    await expect(
      planPort.withVerifiedContentLockPlan(prepared, planBindings, () => {
        throw new Error('a consumed plan must not recapture the actor')
      }),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })
    expect(resolveActorAccountId).toHaveBeenCalledOnce()
    expect(callback).not.toHaveBeenCalled()

    releaseActor()
    await expect(first).resolves.toBe('first')
    expect(callback).toHaveBeenCalledOnce()
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
  })

  it('snapshots supplied bindings before actor capture can race them into a valid token', async () => {
    let releaseActor: () => void = () => undefined
    const actorBarrier = new Promise<void>((resolve) => {
      releaseActor = resolve
    })
    const resolveActorAccountId = vi.fn(async () => {
      await actorBarrier
      return 'actor-account'
    })
    const { planPort } = port(resolveActorAccountId)
    const validBindings = bindings('none')
    const envelope = await envelopeFor(planPort, validBindings, {})
    const mutableBindings = {
      ...validBindings,
      purpose: 'wrong-purpose',
      sourceEntityIds: [...validBindings.sourceEntityIds],
    }
    const callback = vi.fn((verified: VerifiedContentLockPlan<'none'>) =>
      executionFor(verified, requestFor(verified, validBindings), () => 'must not enter'),
    )
    const result = planPort.withVerifiedContentLockPlan(
      planPort.prepareEnvelope(envelope),
      mutableBindings,
      callback,
    )
    await vi.waitFor(() => expect(resolveActorAccountId).toHaveBeenCalledOnce())
    mutableBindings.purpose = validBindings.purpose
    releaseActor()

    await expect(result).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })
    expect(callback).not.toHaveBeenCalled()
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
  })

  it('snapshots caller bindings before verification so later mutation cannot change the lock shape', async () => {
    const { planPort } = port()
    const planBindings = bindings('none')
    const envelope = await envelopeFor(planPort, planBindings, {})

    await expect(
      planPort.withVerifiedContentLockPlan(
        planPort.prepareEnvelope(envelope),
        planBindings,
        (verified) => {
          const mutable = planBindings as unknown as {
            shape: ContentLockPlanShape
            purpose: string
          }
          mutable.shape = 'release-revocation'
          mutable.purpose = 'content-release-revocation'
          return executionFor(
            verified,
            requestFor(verified, planBindings),
            () => 'must not execute',
          )
        },
      ),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
  })

  it('captures the actor exactly once before rejecting any valid cross-binding token', async () => {
    const { planPort, resolveActorAccountId } = port()
    const planBindings = bindings('none')
    const envelope = await envelopeFor(planPort, planBindings, {})
    const wrongSubject = { ...planBindings, subjectId: 'another-subject' }

    await expect(
      planPort.withVerifiedContentLockPlan(
        planPort.prepareEnvelope(envelope),
        wrongSubject,
        () => {
          throw new Error('binding failure must precede the callback')
        },
      ),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })
    expect(resolveActorAccountId).toHaveBeenCalledOnce()
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
  })

  it('captures a valid wrong-actor token once but never opens a verified scope', async () => {
    const resolveActorAccountId = vi.fn(async () => 'another-account')
    const { planPort } = port(resolveActorAccountId)
    const planBindings = bindings('none')
    const envelope = await envelopeFor(planPort, planBindings, {})

    await expect(
      planPort.withVerifiedContentLockPlan(
        planPort.prepareEnvelope(envelope),
        planBindings,
        () => {
          throw new Error('actor failure must precede the callback')
        },
      ),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })
    expect(resolveActorAccountId).toHaveBeenCalledOnce()
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
  })

  it('joins the exact nominal execution and preserves result and error identity', async () => {
    const { planPort } = port()
    const planBindings = bindings('none')
    const envelope = await envelopeFor(planPort, planBindings, {})
    const resultValue = { committed: true }

    const result = await planPort.withVerifiedContentLockPlan(
      planPort.prepareEnvelope(envelope),
      planBindings,
      (verified) =>
        executionFor(verified, requestFor(verified, planBindings), () => resultValue),
    )
    expect(result).toBe(resultValue)

    const original = new Error('unit of work failed')
    await expect(
      planPort.withVerifiedContentLockPlan(
        planPort.prepareEnvelope(envelope),
        planBindings,
        (verified) =>
          executionFor(verified, requestFor(verified, planBindings), () => {
            throw original
          }),
      ),
    ).rejects.toBe(original)
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
  })

  it('cancels and joins an ignored execution before reporting detached work', async () => {
    const { planPort } = port()
    const planBindings = bindings('none')
    const envelope = await envelopeFor(planPort, planBindings, {})
    let retained: ConsumedContentLockPlan | undefined
    let observedAbort = false

    await expect(
      planPort.withVerifiedContentLockPlan(
        planPort.prepareEnvelope(envelope),
        planBindings,
        (verified) => {
          const execution = executionFor(
            verified,
            requestFor(verified, planBindings),
            (consumed) => {
              retained = consumed
              return new Promise<never>((_resolve, reject) => {
                const onAbort = (): void => {
                  observedAbort = true
                  reject(new Error('parent cancelled ignored execution'))
                }
                if (consumed.signal.aborted) onAbort()
                else consumed.signal.addEventListener('abort', onAbort, { once: true })
              })
            },
          )
          void execution
          return 'ignored execution' as unknown as ContentLockedUnitOfWorkExecution<string>
        },
      ),
    ).rejects.toMatchObject({ code: 'uow.detached-work' })

    expect(observedAbort).toBe(true)
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
    const closed = retained
    if (!closed) throw new Error('ignored consumed scope was not retained')
    expect(() => closed.assertActive()).toThrow(
      expect.objectContaining({ code: 'uow.scope-revoked' }),
    )
  })

  it('preserves a synchronous callback error after cancelling its started execution', async () => {
    const { planPort } = port()
    const planBindings = bindings('none')
    const envelope = await envelopeFor(planPort, planBindings, {})
    const original = new Error('callback failed after entry')
    let observedAbort = false

    await expect(
      planPort.withVerifiedContentLockPlan(
        planPort.prepareEnvelope(envelope),
        planBindings,
        (verified) => {
          void executionFor(
            verified,
            requestFor(verified, planBindings),
            (consumed) =>
              new Promise<never>((_resolve, reject) => {
                consumed.signal.addEventListener(
                  'abort',
                  () => {
                    observedAbort = true
                    reject(new Error('cancelled child'))
                  },
                  { once: true },
                )
              }),
          )
          throw original
        },
      ),
    ).rejects.toBe(original)

    expect(observedAbort).toBe(true)
    expect(planPort.activeVerifiedScopeCount()).toBe(0)
  })

  it('rejects a missing execution and every request binding mismatch before admission', async () => {
    const { planPort } = port()
    const planBindings = bindings('none')
    const envelope = await envelopeFor(planPort, planBindings, {})

    await expect(
      planPort.withVerifiedContentLockPlan(
        planPort.prepareEnvelope(envelope),
        planBindings,
        () =>
          'forgot to enter the UoW' as unknown as ContentLockedUnitOfWorkExecution<string>,
      ),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })

    const mismatches: readonly ((
      request: ContentLockedUnitOfWorkRequest,
    ) => ContentLockedUnitOfWorkRequest)[] = [
      (request) =>
        ({
          ...request,
          authority: { ...request.authority, actorUserId: 'another-account' },
        }) as ContentLockedUnitOfWorkRequest,
      (request) =>
        ({
          ...request,
          subjectLock: { subjectUserId: 'another-subject', mode: 'exclusive' },
        }) as ContentLockedUnitOfWorkRequest,
      (request) => ({ ...request, expectedEpoch: anotherEpoch }),
      (request) => ({ ...request, workflowPurpose: 'another-workflow' }),
      (request) => withRequestBindings(request, { purpose: 'another-purpose' }),
      (request) => withRequestBindings(request, { formOrCommandId: 'another-command' }),
      (request) => withRequestBindings(request, { sourceEntityIds: ['another-source'] }),
      (request) => withRequestBindings(request, { expectedGeneration: generation }),
      (request) =>
        ({
          ...request,
          operation: 'current-publication.initial',
        }) as ContentLockedUnitOfWorkRequest,
    ]

    for (const mismatch of mismatches) {
      await expect(
        planPort.withVerifiedContentLockPlan(
          planPort.prepareEnvelope(envelope),
          planBindings,
          (verified) =>
            executionFor(
              verified,
              mismatch(requestFor(verified, planBindings)),
              () => 'must not execute',
            ),
        ),
      ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })
      expect(planPort.activeVerifiedScopeCount()).toBe(0)
    }
  })

  it('rejects illegal issuance shapes with the canonical integrity error', async () => {
    const { planPort } = port()
    const illegal = {
      ...bindings('none'),
      shape: 'not-a-content-shape',
    } as unknown as ContentLockPlanBindings

    await expect(
      planPort.withIssuanceScope(illegal, async ({ seal }) => seal([])),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })
  })

  it('rejects duplicate, missing, extra, underlocked, and over-broad owner projections', async () => {
    const { planPort } = port()

    await expect(
      envelopeFor(planPort, bindings('current-publication.initial'), {
        methodology: [methodology],
      }),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })

    await expect(
      envelopeFor(planPort, bindings('current-publication.initial'), {
        methodology: [methodology, methodology],
      }),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })

    await expect(
      envelopeFor(planPort, bindings('current-publication.initial'), {
        methodology: [methodology, template],
        programs: [methodology, template],
      }),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })

    await expect(
      envelopeFor(planPort, bindings('correction-closure'), {
        programs: [methodology, template],
        training: [],
      }),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })

    await expect(
      envelopeFor(planPort, bindings('correction-closure'), {
        programs: [methodology, template],
        training: [methodology],
      }),
    ).rejects.toMatchObject({ code: 'content-lock-plan.invalid' })

    const sixtyTwoAdditionalTrainingKeys = Array.from({ length: 62 }, (_, index) => ({
      kind: 'methodology' as const,
      id: `history-${String(index).padStart(2, '0')}`,
      version: '1',
    }))
    const maximumBindings = bindings('correction-closure')
    const maximumSlots = {
      programs: [methodology, template],
      training: [methodology, template, ...sixtyTwoAdditionalTrainingKeys],
    } as const
    const maximumEnvelope = await envelopeFor(planPort, maximumBindings, maximumSlots)
    expect(decodedPayload(maximumEnvelope).keys).toHaveLength(64)
    await expect(
      planPort.withVerifiedContentLockPlan(
        planPort.prepareEnvelope(maximumEnvelope),
        maximumBindings,
        (verified) =>
          executionFor(verified, requestFor(verified, maximumBindings), (consumed) => {
            expect(consumed.lockKeys).toHaveLength(64)
            consumed.attestor.assertCurrentLockedContentSet(
              transactionFragments(consumed, maximumSlots),
            )
            return 'accepted'
          }),
      ),
    ).resolves.toBe('accepted')

    const sixtyThreeAdditionalTrainingKeys = Array.from({ length: 63 }, (_, index) => ({
      kind: 'methodology' as const,
      id: `history-${String(index).padStart(2, '0')}`,
      version: '1',
    }))
    await expect(
      envelopeFor(planPort, bindings('correction-closure'), {
        programs: [methodology, template],
        training: [methodology, template, ...sixtyThreeAdditionalTrainingKeys],
      }),
    ).rejects.toMatchObject({
      code: 'content-lock-plan.too-large',
      disposition: 'no-self-service',
    })
  })

  it('accepts an exact 16 KiB canonical envelope and rejects one byte beyond it', async () => {
    const { planPort } = port()
    const fixedSources = Array.from(
      { length: 40 },
      (_, index) => `source-${String(index).padStart(2, '0')}-${'a'.repeat(280)}`,
    )
    const exactBindings = {
      ...bindings('none'),
      sourceEntityIds: [...fixedSources, `source-zz-${'x'.repeat(216)}`],
    }
    const exactEnvelope = await envelopeFor(planPort, exactBindings, {})

    expect(Buffer.byteLength(exactEnvelope, 'utf8')).toBe(maximumTestEnvelopeBytes())
    expect(() => planPort.prepareEnvelope(exactEnvelope)).not.toThrow()

    const oversizedBindings = {
      ...exactBindings,
      sourceEntityIds: [...fixedSources, `source-zz-${'x'.repeat(217)}`],
    }
    await expect(envelopeFor(planPort, oversizedBindings, {})).rejects.toMatchObject({
      code: 'content-lock-plan.too-large',
      disposition: 'no-self-service',
    })

    const encodedPayload = exactEnvelope.split('.')[0]
    if (!encodedPayload) throw new Error('exact envelope payload missing')
    const oversizedCanonicalPayload = Buffer.from(encodedPayload, 'base64url')
      .toString('utf8')
      .replace(`source-zz-${'x'.repeat(216)}`, `source-zz-${'x'.repeat(217)}`)
    const oversizedEnvelope = signRawPayload(oversizedCanonicalPayload)
    expect(Buffer.byteLength(oversizedEnvelope, 'utf8')).toBeGreaterThan(
      maximumTestEnvelopeBytes(),
    )
    expect(() => planPort.prepareEnvelope(oversizedEnvelope)).toThrow(
      expect.objectContaining({ code: 'content-lock-plan.invalid' }),
    )
  })
})

function maximumTestEnvelopeBytes(): number {
  return 16 * 1024
}
